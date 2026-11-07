import type { TranscriptTurn } from "./schemas.ts";
import { type Candidate, candidateId, type Candidates, cleanTitle } from "./candidates.ts";
import { commandLabel, commandOf, isReadOnlyCommand, normalizeCommand } from "./commands.ts";

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "shell",
  "exec_command",
  "run_terminal_cmd",
  "run_command",
  "local_shell",
]);
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "edit_file",
  "write_file",
  "search_replace",
]);
const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "read_file",
  "list_dir",
  "grep_search",
  "file_search",
  "codebase_search",
]);
const FILE_ARGUMENTS = ["file_path", "path", "file", "notebook_path", "target_file"] as const;
const OUTPUT_HEAD_FOR_THE_MODEL = 300;
const ASK_HEAD_FOR_THE_MODEL = 400;
/** A result whose output starts with this words says the command failed, whatever the harness flagged. */
const EXIT_FAILURE = /^(?:exit code|process exited with code)[: ]+([1-9]\d*)/i;

/** The turns between `from` and `to`, 1-based and inclusive, both optional. */
export interface TurnRange {
  readonly from?: number;
  readonly to?: number;
}

interface Call {
  readonly turnId: number;
  readonly callId: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: string;
  readonly failed: boolean;
  readonly ask: string;
}

const head = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

function fileOf(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of FILE_ARGUMENTS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Pairs every in-range tool call with its result (found anywhere in the transcript) and the ask that preceded it. */
function pairedCalls(turns: readonly TranscriptTurn[], range: TurnRange): Call[] {
  const results = new Map<string, NonNullable<TranscriptTurn["tool_result"]>>();
  for (const turn of turns) if (turn.tool_result !== undefined) results.set(turn.tool_result.id, turn.tool_result);
  const calls: Call[] = [];
  let ask = "";
  turns.forEach((turn, index) => {
    const turnId = index + 1;
    if (turn.role === "user" && turn.text.trim() !== "") ask = head(turn.text.trim(), ASK_HEAD_FOR_THE_MODEL);
    const call = turn.tool_call;
    if (call === undefined || turnId < (range.from ?? 1) || turnId > (range.to ?? Number.POSITIVE_INFINITY)) return;
    const result = results.get(call.id);
    const output = result?.output ?? "";
    calls.push({
      turnId,
      callId: call.id,
      name: call.name,
      input: call.input,
      output,
      failed: result !== undefined && (result.is_error || EXIT_FAILURE.test(output.trim())),
      ask,
    });
  });
  return calls;
}

interface Kept {
  readonly call: Call;
  readonly command?: string;
  readonly edit?: string;
  readonly attempts: number;
}

function toCandidate(kept: Kept, index: number): Candidate {
  const { call } = kept;
  const evidence = [{ turn_id: call.turnId, call_id: call.callId }];
  if (kept.edit !== undefined) {
    const file = kept.edit;
    return {
      id: candidateId(index),
      title: cleanTitle(`Edit ${file.slice(file.lastIndexOf("/") + 1)}`),
      edit: file,
      commandOnly: false,
      text: `${call.name} edited the file ${file}`,
      context: call.ask,
      evidence,
      retried: false,
    };
  }
  const command = kept.command!;
  const description = typeof call.input.description === "string" ? call.input.description : "";
  const result = call.output === "" ? "" : `\nOutput starts: ${head(call.output, OUTPUT_HEAD_FOR_THE_MODEL)}`;
  return {
    id: candidateId(index),
    title: cleanTitle(description !== "" ? description : `Run ${commandLabel(command)}`),
    command,
    commandOnly: true,
    text: `Ran the command: ${command}${result}`,
    context: call.ask,
    evidence,
    retried: kept.attempts > 1,
  };
}

/**
 * The candidate steps of a transcript read with its tool calls: shell commands and file edits, in the order they ran.
 * Pure reads (read-only commands, Read/Glob/Grep) are dropped. A command that failed is dropped; a command run again
 * later keeps only its last run. When a failure is followed by a success of the same command, the success stands and
 * is marked as retried.
 */
export function transcriptCandidates(turns: readonly TranscriptTurn[], range: TurnRange = {}): Candidates {
  const entries: Kept[] = [];
  let reads = 0;
  let seen = 0;
  for (const call of pairedCalls(turns, range)) {
    if (READ_TOOLS.has(call.name)) {
      reads += 1;
      seen += 1;
    } else if (SHELL_TOOLS.has(call.name)) {
      const command = commandOf(call.input);
      if (command === undefined) continue;
      seen += 1;
      if (isReadOnlyCommand(command)) reads += 1;
      else entries.push({ call, command, attempts: 1 });
    } else if (EDIT_TOOLS.has(call.name)) {
      seen += 1;
      entries.push({ call, edit: fileOf(call.input) ?? call.name, attempts: 1 });
    }
  }

  const attempts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.command === undefined) continue;
    const key = normalizeCommand(entry.command);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }
  let retries = 0;
  let failed = 0;
  const succeeded = new Set<string>();
  const kept: Kept[] = [];
  for (const entry of [...entries].reverse()) {
    const key = entry.command === undefined ? undefined : normalizeCommand(entry.command);
    if (entry.call.failed) {
      if (key !== undefined && succeeded.has(key)) retries += 1;
      else failed += 1;
    } else if (key !== undefined && succeeded.has(key)) {
      retries += 1;
    } else {
      if (key !== undefined) succeeded.add(key);
      kept.push({ ...entry, attempts: key === undefined ? 1 : attempts.get(key)! });
    }
  }
  return {
    candidates: kept.reverse().map(toCandidate),
    seen,
    dropped: { reads, retries, failed },
  };
}
