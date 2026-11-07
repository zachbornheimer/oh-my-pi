import type { SessionMetadata, TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";

export type JsonRecord = Readonly<Record<string, unknown>>;

/** Reads one parsed JSON record of a transcript into the turns it holds. */
export type RecordParser = (record: JsonRecord) => TranscriptTurn[];

/** Reads what one parsed JSON record says about where the session ran; `{}` when it says nothing. */
export type RecordMetadata = (record: JsonRecord) => SessionMetadata;

/** The turns of a session read whole from a store, with what the store recorded about where it ran. */
export interface SessionTurns {
  readonly turns: TranscriptTurn[];
  readonly metadata: SessionMetadata;
}

/** `metadata` with the fields `later` set replacing its own: the last value a harness recorded wins. */
export function mergeMetadata(metadata: SessionMetadata, later: SessionMetadata): SessionMetadata {
  return {
    ...metadata,
    ...(later.cwd === undefined ? {} : { cwd: later.cwd }),
    ...(later.git_branch === undefined ? {} : { git_branch: later.git_branch }),
  };
}

/** The metadata fields that are non-blank strings; a harness's own empty or non-string value is no metadata. */
export function sessionMetadata(cwd: unknown, gitBranch: unknown): SessionMetadata {
  return {
    ...(typeof cwd === "string" && cwd.trim() !== "" ? { cwd } : {}),
    ...(typeof gitBranch === "string" && gitBranch.trim() !== "" ? { git_branch: gitBranch } : {}),
  };
}

/** `{ metadata }` when anything was recorded and nothing otherwise, so a transcript leaves the key out. */
export function metadataEntry(metadata: SessionMetadata): { readonly metadata?: SessionMetadata } {
  return metadata.cwd === undefined && metadata.git_branch === undefined ? {} : { metadata };
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const stringField = (record: JsonRecord, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : "";
};

export const recordField = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

/** The non-blank trimmed `text` fields of the `{type, text}` blocks, in order. */
export function blockTexts(blocks: readonly unknown[], blockType?: string): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (blockType !== undefined && block.type !== blockType) continue;
    const text = trimSpace(stringField(block, "text"));
    if (text !== "") texts.push(text);
  }
  return texts;
}

const USER_QUERY_OPEN = "<user_query>";
const USER_QUERY_CLOSE = "</user_query>";

/** agentmux `transcript.UnwrapUserQuery`: the body inside `<user_query>` tags, or the text trimmed when there are none. */
export function unwrapUserQuery(text: string): string {
  const open = text.indexOf(USER_QUERY_OPEN);
  if (open < 0) return trimSpace(text);
  const start = open + USER_QUERY_OPEN.length;
  const close = text.indexOf(USER_QUERY_CLOSE, start);
  return trimSpace(close < 0 ? text.slice(start) : text.slice(start, close));
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function isoSeconds(time: Date): string | undefined {
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A time a harness wrote as an ISO-8601 string with a zone (`2026-10-13T15:51:44.132Z`) as UTC to the second
 * (`2026-10-13T15:51:44Z`). Anything else, including a string with no zone, is `undefined`: a time is never guessed.
 */
export function isoFromString(value: unknown): string | undefined {
  return typeof value === "string" && ISO_WITH_ZONE.test(value) ? isoSeconds(new Date(value)) : undefined;
}

/** A Unix time in seconds (Hermes `messages.timestamp`, a REAL) as UTC to the second; `undefined` when it is not a finite number. */
export function isoFromEpochSeconds(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? isoSeconds(new Date(value * 1000)) : undefined;
}

/** A Unix time in milliseconds (OpenCode `time_created`) as UTC to the second; `undefined` when it is not a finite number. */
export function isoFromEpochMillis(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? isoSeconds(new Date(value)) : undefined;
}

/** `turn` with `timestamp` set when there is one; the turn is returned as it is otherwise (the field stays absent). */
export function stamped(turn: TranscriptTurn, timestamp: string | undefined): TranscriptTurn {
  return timestamp === undefined ? turn : { ...turn, timestamp };
}

/** A parser whose turns each carry the record's own top-level `timestamp` (an ISO string) when the record has one. */
export function withRecordTimestamp(parse: RecordParser): RecordParser {
  return (record) => {
    const timestamp = isoFromString(record.timestamp);
    return parse(record).map((turn) => stamped(turn, timestamp));
  };
}
