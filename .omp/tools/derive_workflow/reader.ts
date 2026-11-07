import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CONVERSATION_REF,
  type DeriveInput,
  type Transcript,
  type TranscriptTurn,
} from "./schemas.ts";
import { grokCompactionSummary, isRecord, jsonlTurns, RECORD_PARSERS } from "./transcripts.ts";

/**
 * The plain filesystem reader of the source: a conversation ref `<harness>:<id>` becomes a transcript with its tool calls
 * kept, anything else is read as a file. It only reads. `home` and `cwd` are seams so tests run against a temp directory.
 */

export interface ReaderEnvironment {
  readonly home: string;
  readonly cwd: string;
}

/** Harnesses whose transcripts carry tool calls and are read here. Others (cursor, hermes, opencode, copilot, omp, pi, agentmux) are not. */
export const TOOL_CALL_HARNESSES = ["claude", "codex", "grok"] as const;
type ToolCallHarness = (typeof TOOL_CALL_HARNESSES)[number];

const LATEST = "latest";
/** The name agentmux gives a harness in its captured copies, `~/.config/agentmux/transcripts/<name>.<id>.jsonl`. */
const CAPTURED_NAME: Record<ToolCallHarness, string> = { claude: "claude-code", codex: "codex", grok: "grok" };
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;
const MAX_LISTED = 10;

interface Session {
  readonly id: string;
  readonly path: string;
  readonly modifiedMs: number;
}

async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

async function fileOf(path: string): Promise<Session | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { id: "", path, modifiedMs: info.mtimeMs } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Every session of the harness's own store, with its file. */
async function listSessions(harness: ToolCallHarness, home: string): Promise<Session[]> {
  const sessions: Session[] = [];
  const add = async (id: string, path: string): Promise<void> => {
    const file = await fileOf(path);
    if (file !== undefined) sessions.push({ ...file, id });
  };
  if (harness === "claude") {
    const root = join(home, ".claude/projects");
    for (const project of await names(root)) {
      for (const name of await names(join(root, project))) {
        if (name.endsWith(".jsonl")) await add(name.slice(0, -".jsonl".length), join(root, project, name));
      }
    }
  } else if (harness === "grok") {
    const root = join(home, ".grok/sessions");
    for (const workspace of await names(root)) {
      for (const id of await names(join(root, workspace))) await add(id, join(root, workspace, id, "chat_history.jsonl"));
    }
  } else {
    const root = join(home, ".codex/sessions");
    for (const year of await names(root)) {
      for (const month of await names(join(root, year))) {
        for (const day of await names(join(root, year, month))) {
          for (const name of await names(join(root, year, month, day))) {
            const id = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(name)?.[1];
            if (id !== undefined) await add(id, join(root, year, month, day, name));
          }
        }
      }
    }
  }
  return sessions;
}

/** agentmux's captured copy of a full session id, when it has one. */
async function capturedCopy(harness: ToolCallHarness, id: string, home: string): Promise<Session | undefined> {
  const path = join(home, ".config/agentmux/transcripts", `${CAPTURED_NAME[harness]}.${id}.jsonl`);
  const file = await fileOf(path);
  return file === undefined ? undefined : { ...file, id };
}

async function isSubagent(session: Session): Promise<boolean> {
  try {
    const summary: unknown = JSON.parse(await readFile(join(dirname(session.path), "summary.json"), "utf8"));
    return isRecord(summary) && summary.session_kind === "subagent";
  } catch {
    return false;
  }
}

const describe = (session: Session): string => `  ${session.id}  ${new Date(session.modifiedMs).toISOString().slice(0, 16)}Z`;

async function locate(harness: ToolCallHarness, identifier: string, home: string): Promise<Session> {
  const conversation = `${harness}:${identifier}`;
  if (identifier !== LATEST) {
    const captured = await capturedCopy(harness, identifier, home);
    if (captured !== undefined) return captured;
  }
  const sessions = await listSessions(harness, home);
  if (sessions.length === 0) throw new Error(`transcript: no ${harness} sessions found for ${conversation}`);
  if (identifier === LATEST) {
    const topLevel: Session[] = [];
    for (const session of sessions) if (harness !== "grok" || !(await isSubagent(session))) topLevel.push(session);
    const newest = topLevel.sort((a, b) => b.modifiedMs - a.modifiedMs)[0];
    if (newest === undefined) throw new Error(`transcript: no top-level ${harness} session to take as the latest`);
    return newest;
  }
  const exact = sessions.filter((session) => session.id === identifier);
  const matches = exact.length > 0 ? exact : sessions.filter((session) => session.id.startsWith(identifier));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const shown = matches.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAX_LISTED);
    throw new Error(
      `transcript: ${matches.length} ${harness} sessions start with "${identifier}" for ${conversation}; use the full id of one:\n${shown.map(describe).join("\n")}`,
    );
  }
  const recent = sessions.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, 5);
  throw new Error(
    `transcript: no ${harness} session id starts with "${identifier}" for ${conversation}\nRecent sessions:\n${recent.map(describe).join("\n")}`,
  );
}

/** One `context` turn per Grok compaction segment, oldest first; the live `chat_history.jsonl` holds only the tail after a compaction. */
async function grokCompactionTurns(sessionDirectory: string): Promise<TranscriptTurn[]> {
  const directory = join(sessionDirectory, "compaction");
  const segments = (await names(directory)).filter((name) => name.startsWith("segment_") && name.endsWith(".md")).sort();
  const turns: TranscriptTurn[] = [];
  for (const name of segments) {
    const summary = grokCompactionSummary(await readFile(join(directory, name), "utf8"));
    if (summary === undefined) continue;
    turns.push({
      role: "context",
      text: `COMPACTED EARLIER TURNS (${name.slice(0, -".md".length)}):\n${summary}`,
      synthetic_reason: "compaction_summary",
    });
  }
  return turns;
}

/** The transcript of `<harness>:<id>`, tool calls kept. Throws, naming what was tried, when no session matches. */
export async function readConversation(source: string, environment: ReaderEnvironment): Promise<Transcript> {
  const separator = source.indexOf(":");
  const harness = source.slice(0, separator);
  const identifier = source.slice(separator + 1);
  if (!(TOOL_CALL_HARNESSES as readonly string[]).includes(harness)) {
    throw new Error(
      `derive_workflow: ${harness} transcripts carry no tool calls here; read ${TOOL_CALL_HARNESSES.join(", ")} sessions, or pass the path of a script, SKILL.md or runbook`,
    );
  }
  if (identifier !== LATEST && !SESSION_ID.test(identifier)) {
    throw new Error(`transcript: session identifier "${identifier}" must be a session id, the start of one, or "${LATEST}"`);
  }
  const session = await locate(harness as ToolCallHarness, identifier, environment.home);
  const { turns, skippedLines } = jsonlTurns(await readFile(session.path, "utf8"), RECORD_PARSERS[harness as ToolCallHarness]);
  const own = harness === "grok" && basename(session.path) === "chat_history.jsonl"
    ? await grokCompactionTurns(dirname(session.path))
    : [];
  return { path: session.path, turns: [...own, ...turns], skipped_lines: skippedLines };
}

/** `~/` is the home directory, an absolute path stays, anything else is from the working directory. */
export function pathOf(source: string, environment: ReaderEnvironment): string {
  if (source.startsWith("~/")) return join(environment.home, source.slice(2));
  return source.startsWith("/") ? source : join(environment.cwd, source);
}

/**
 * Reads what `source` names: a conversation ref becomes its transcript with the tool calls kept, anything else is read as
 * a UTF-8 file. It only reads. A source it cannot read throws.
 */
export async function readSource(input: DeriveInput, environment: ReaderEnvironment): Promise<DeriveInput> {
  if (input.transcript !== undefined || input.document !== undefined) return input;
  const source = input.source.trim();
  if (source === "") throw new Error("derive_workflow: source is empty");
  if (CONVERSATION_REF.test(source)) return { ...input, source, transcript: await readConversation(source, environment) };
  const path = pathOf(source, environment);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `derive_workflow: cannot read ${path} (${(error as Error).message}); the source is a conversation ref such as claude:<id> or a readable file`,
    );
  }
  return { ...input, source, document: { path, text } };
}
