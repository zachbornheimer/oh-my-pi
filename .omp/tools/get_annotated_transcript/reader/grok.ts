import { COMPACTION_SUMMARY } from "./schemas.js";
import type { SessionMetadata, TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import type { HostMachine } from "./host_machine.js";
import { blockTexts, isRecord, recordField, sessionMetadata, stringField, unwrapUserQuery } from "./records.js";
import type { RecordParser } from "./records.js";
import { argumentsOf, toolCallTurn, toolResultTurn } from "./tool_turns.js";

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const SUMMARY_HEADING = "## Summary (curated by compaction step)";
const NEXT_SECTION = "\n## ";
const COMPACTION_DIRECTORY = "compaction";
const SEGMENT_PREFIX = "segment_";
const SEGMENT_SUFFIX = ".md";
const SUMMARY_FILE = "summary.json";

/**
 * agentmux `transcript.DecodeGrokContent`: a bare string, a `[{type, text}]` block array joined by newlines, or, for
 * a shape it does not know, the raw JSON text.
 */
export function decodeGrokContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return trimSpace(content);
  if (Array.isArray(content)) return blockTexts(content).join("\n");
  return trimSpace(JSON.stringify(content));
}

/**
 * Grok `chat_history.jsonl` (agentmux `transcript.ParseGrokTurns`): `user` items (`<system-reminder>` injections removed,
 * unwrapped from `<user_query>`, one left empty dropped; the harness's own `synthetic_reason` is kept so such turns are
 * not mistaken for a human) and `assistant` items' text.
 * An assistant item's `tool_calls` and the `tool_result` items that answer them become `tool` turns (Grok sends no error
 * signal for a result, so none is guessed). System, reasoning and unrecognized items are not emitted.
 */
export const grokRecordTurns: RecordParser = (record) => {
  if (record.type === "user") {
    const text = unwrapUserQuery(decodeGrokContent(record.content).replace(SYSTEM_REMINDER, ""));
    if (text === "") return [];
    const turn: TranscriptTurn = { role: "user", text };
    const syntheticReason = stringField(record, "synthetic_reason");
    return [syntheticReason === "" ? turn : { ...turn, synthetic_reason: syntheticReason }];
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

/** The curated summary of one compaction segment file; `undefined` when it has no summary heading or the summary is empty. */
export function grokCompactionSummary(segment: string): string | undefined {
  const start = segment.indexOf(SUMMARY_HEADING);
  if (start < 0) return undefined;
  const body = segment.slice(start + SUMMARY_HEADING.length);
  const end = body.indexOf(NEXT_SECTION);
  const summary = trimSpace(end < 0 ? body : body.slice(0, end));
  return summary === "" ? undefined : summary;
}

/**
 * After compaction `chat_history.jsonl` holds only the live tail; Grok keeps what came before in
 * `<session>/compaction/segment_NNN.md`. One `context` turn per segment, oldest first, carries the segment's curated
 * summary (the verbatim turns that follow it in the file are not read: they run to hundreds of KB).
 */
export async function grokCompactionTurns(sessionDirectory: string, machine: HostMachine): Promise<TranscriptTurn[]> {
  const directory = `${sessionDirectory}/${COMPACTION_DIRECTORY}`;
  const segments = (await machine.listDirectory(directory))
    .filter((name) => name.startsWith(SEGMENT_PREFIX) && name.endsWith(SEGMENT_SUFFIX))
    .sort();
  const turns: TranscriptTurn[] = [];
  for (const name of segments) {
    const text = await machine.readTextFile(`${directory}/${name}`);
    const summary = text === undefined ? undefined : grokCompactionSummary(text);
    if (summary === undefined) continue;
    turns.push({
      role: "context",
      text: `COMPACTED EARLIER TURNS (${name.slice(0, -SEGMENT_SUFFIX.length)}):\n${summary}`,
      synthetic_reason: COMPACTION_SUMMARY,
    });
  }
  return turns;
}

/** Where Grok says the session ran: `summary.json` beside `chat_history.jsonl` has the `info.cwd` and the `head_branch`. */
export async function grokSummaryMetadata(sessionDirectory: string, machine: HostMachine): Promise<SessionMetadata> {
  const text = await machine.readTextFile(`${sessionDirectory}/${SUMMARY_FILE}`);
  if (text === undefined) return {};
  let summary: unknown;
  try {
    summary = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(summary)) return {};
  return sessionMetadata(recordField(summary, "info")?.cwd, summary.head_branch);
}
