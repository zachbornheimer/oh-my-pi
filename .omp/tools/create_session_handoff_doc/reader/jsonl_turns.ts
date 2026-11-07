import type { SessionMetadata, TranscriptTurn } from "./schemas.js";
import { isRecord, mergeMetadata } from "./records.js";
import type { RecordMetadata, RecordParser } from "./records.js";

export interface JsonlTurns {
  readonly turns: TranscriptTurn[];
  /** Lines that were not a JSON object. */
  readonly skippedLines: number;
  /** What the records recorded about where the session ran, the last value of each field; `{}` when nothing. */
  readonly metadata: SessionMetadata;
}

/**
 * Reads a JSONL transcript line by line. A line that is not a JSON object is counted and left out, not fatal.
 * `metadataOf`, when given, reads each record's own statement of where the session ran.
 */
export async function jsonlTurns(
  lines: AsyncIterable<string>,
  parse: RecordParser,
  metadataOf?: RecordMetadata,
): Promise<JsonlTurns> {
  const turns: TranscriptTurn[] = [];
  let skippedLines = 0;
  let metadata: SessionMetadata = {};
  for await (const line of lines) {
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
    if (metadataOf !== undefined) metadata = mergeMetadata(metadata, metadataOf(record));
  }
  return { turns, skippedLines, metadata };
}
