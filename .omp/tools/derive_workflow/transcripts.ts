import type { TranscriptTurn } from "./schemas.ts";
import { TOOL_OUTPUT_HEAD_CHARS } from "./schemas.ts";

/**
 * The record parsers of the harnesses whose transcripts carry tool calls (claude, codex, grok), copied from the Mastra
 * reader (`runtime/cli/gather/transcripts/{claude,codex,grok,tool_turns,records}.ts`). Each turns one parsed JSONL record
 * into turns; tool calls and their results become `tool` turns joined by id, with the output cut to its first
 * TOOL_OUTPUT_HEAD_CHARS characters.
 */

export type JsonRecord = Readonly<Record<string, unknown>>;
export type RecordParser = (record: JsonRecord) => TranscriptTurn[];

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stringField = (record: JsonRecord, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : "";
};

const recordField = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

/** The non-blank trimmed `text` fields of the `{type, text}` blocks, in order. */
function blockTexts(blocks: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const text = stringField(block, "text").trim();
    if (text !== "") texts.push(text);
  }
  return texts;
}

function toolCallTurn(id: string, name: string, input: Readonly<Record<string, unknown>>): TranscriptTurn {
  return { role: "tool", text: "", tool_call: { id, name, input: { ...input } } };
}

/** The `tool` turn of a call's result; the output keeps its first TOOL_OUTPUT_HEAD_CHARS characters (code points). */
function toolResultTurn(id: string, output: string, isError: boolean): TranscriptTurn {
  const head = output.length <= TOOL_OUTPUT_HEAD_CHARS
    ? output
    : Array.from(output.slice(0, 2 * TOOL_OUTPUT_HEAD_CHARS)).slice(0, TOOL_OUTPUT_HEAD_CHARS).join("");
  return { role: "tool", text: "", tool_result: { id, output: head, is_error: isError } };
}

/** The arguments of a call a harness wrote as a JSON string: an object stays one, anything else is kept under `raw`. */
function argumentsOf(wire: unknown): Record<string, unknown> {
  if (isRecord(wire)) return { ...wire };
  if (typeof wire !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(wire);
    return isRecord(parsed) ? { ...parsed } : { raw: wire };
  } catch {
    return wire === "" ? {} : { raw: wire };
  }
}

/** The text of a tool result's `content`: a string, or `{type, text}` blocks joined by newlines. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? blockTexts(content).join("\n") : "";
}

// --- claude ------------------------------------------------------------------------------------------------------

type Speaker = "user" | "agent";

function claudeBlockTurn(role: Speaker, block: JsonRecord): TranscriptTurn | undefined {
  if (block.type === "text") {
    const text = stringField(block, "text").trim();
    return text === "" ? undefined : { role, text };
  }
  if (block.type === "tool_use") {
    return toolCallTurn(stringField(block, "id"), stringField(block, "name"), argumentsOf(block.input));
  }
  if (block.type === "tool_result") {
    const output = stringField(block, "text").trim() || resultText(block.content);
    return toolResultTurn(stringField(block, "tool_use_id"), output, block.is_error === true);
  }
  return undefined;
}

/** Claude Code session JSONL: `user` and `assistant` records carry a message whose content is a string or typed blocks. */
export const claudeRecordTurns: RecordParser = (record) => {
  if (record.type !== "user" && record.type !== "assistant") return [];
  const message = recordField(record, "message");
  if (message === undefined) return [];
  const role: Speaker = stringField(message, "role") === "assistant" ? "agent" : "user";
  const content = message.content;
  if (typeof content === "string") return content.trim() === "" ? [] : [{ role, text: content.trim() }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((block) => {
    const turn = claudeBlockTurn(role, block);
    return turn === undefined ? [] : [turn];
  });
};

// --- codex -------------------------------------------------------------------------------------------------------

const AGENTS_INSTRUCTIONS_HEADING = "# AGENTS.md instructions";

/** The session-start AGENTS.md block Codex sends as a user message. */
const isAgentsInstructions = (text: string): boolean =>
  text.startsWith(AGENTS_INSTRUCTIONS_HEADING) && text.includes("<INSTRUCTIONS>") && text.includes("</INSTRUCTIONS>");

/** Output a tool wrote to say it failed. */
const FAILED_OUTPUT_PREFIX = /^(?:script failed|tool failed|error:)/i;

/** A function call's output is plain text, or a JSON document `{output, metadata: {exit_code}}`. */
function callOutput(wire: unknown): { readonly text: string; readonly failed: boolean } {
  const raw = typeof wire === "string" ? wire : resultText(wire);
  let text = raw;
  let exitCode = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.output === "string") {
      text = parsed.output;
      const metadata = recordField(parsed, "metadata");
      exitCode = typeof metadata?.exit_code === "number" ? metadata.exit_code : 0;
    }
  } catch {
    // plain text output
  }
  return { text, failed: exitCode !== 0 || FAILED_OUTPUT_PREFIX.test(text.trim()) };
}

function codexFunctionTurn(payload: JsonRecord): TranscriptTurn[] {
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const wire = payload.arguments ?? payload.input;
    return [toolCallTurn(stringField(payload, "call_id"), stringField(payload, "name"), argumentsOf(wire))];
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const { text, failed } = callOutput(payload.output);
    return [toolResultTurn(stringField(payload, "call_id"), text, failed)];
  }
  return [];
}

/** Codex rollout JSONL: `response_item` records whose payload is a `message`, a function call or its output. */
export const codexRecordTurns: RecordParser = (record) => {
  if (record.type !== "response_item") return [];
  const payload = recordField(record, "payload");
  if (payload === undefined) return [];
  if (payload.type !== "message") return codexFunctionTurn(payload);
  const content = payload.content;
  const text = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
    ? blockTexts(content).join("\n")
    : "";
  if (text === "") return [];
  const role = stringField(payload, "role");
  if (role === "assistant") return [{ role: "agent", text }];
  if (role === "user" && !isAgentsInstructions(text)) return [{ role: "user", text }];
  return [];
};

// --- grok --------------------------------------------------------------------------------------------------------

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const USER_QUERY_OPEN = "<user_query>";
const USER_QUERY_CLOSE = "</user_query>";

/** The body inside `<user_query>` tags, or the text trimmed when there are none. */
function unwrapUserQuery(text: string): string {
  const open = text.indexOf(USER_QUERY_OPEN);
  if (open < 0) return text.trim();
  const start = open + USER_QUERY_OPEN.length;
  const close = text.indexOf(USER_QUERY_CLOSE, start);
  return (close < 0 ? text.slice(start) : text.slice(start, close)).trim();
}

/** A bare string, a `[{type, text}]` block array joined by newlines, or the raw JSON text of a shape it does not know. */
function decodeGrokContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return blockTexts(content).join("\n");
  return JSON.stringify(content).trim();
}

/**
 * Grok `chat_history.jsonl`: `user` items (system reminders removed, unwrapped from `<user_query>`), `assistant` items'
 * text, their `tool_calls`, and the `tool_result` items that answer them (Grok sends no error signal, so none is guessed).
 */
export const grokRecordTurns: RecordParser = (record) => {
  if (record.type === "user") {
    const text = unwrapUserQuery(decodeGrokContent(record.content).replace(SYSTEM_REMINDER, ""));
    if (text === "") return [];
    const syntheticReason = stringField(record, "synthetic_reason");
    return [syntheticReason === "" ? { role: "user", text } : { role: "user", text, synthetic_reason: syntheticReason }];
  }
  if (record.type === "assistant") {
    const text = decodeGrokContent(record.content);
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls.filter(isRecord) : [];
    const toolTurns = calls.map((call) =>
      toolCallTurn(stringField(call, "id"), stringField(call, "name"), argumentsOf(call.arguments))
    );
    return [...(text === "" ? [] : [{ role: "agent" as const, text }]), ...toolTurns];
  }
  if (record.type === "tool_result") {
    return [toolResultTurn(stringField(record, "tool_call_id"), decodeGrokContent(record.content), false)];
  }
  return [];
};

const SUMMARY_HEADING = "## Summary (curated by compaction step)";
const NEXT_SECTION = "\n## ";

/** The curated summary of one compaction segment file; undefined when it has no summary heading or the summary is empty. */
export function grokCompactionSummary(segment: string): string | undefined {
  const start = segment.indexOf(SUMMARY_HEADING);
  if (start < 0) return undefined;
  const body = segment.slice(start + SUMMARY_HEADING.length);
  const end = body.indexOf(NEXT_SECTION);
  const summary = (end < 0 ? body : body.slice(0, end)).trim();
  return summary === "" ? undefined : summary;
}

export const RECORD_PARSERS = { claude: claudeRecordTurns, codex: codexRecordTurns, grok: grokRecordTurns } as const;

/** Parses JSONL text into turns. A line that is not a JSON object is counted and left out. */
export function jsonlTurns(text: string, parse: RecordParser): { turns: TranscriptTurn[]; skippedLines: number } {
  const turns: TranscriptTurn[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(record)) {
      skippedLines += 1;
      continue;
    }
    turns.push(...parse(record));
  }
  return { turns, skippedLines };
}
