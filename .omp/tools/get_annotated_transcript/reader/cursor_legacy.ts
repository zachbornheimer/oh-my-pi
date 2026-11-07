import { type Infer, z } from "./shape.js";
import type { SessionMetadata, Transcript, TranscriptTurn } from "./schemas.js";
import type { HostMachine } from "./host_machine.js";
import { cursorRecordMetadata, cursorRecordTurns } from "./cursor.js";
import { isRecord, mergeMetadata, metadataEntry } from "./records.js";
import type { JsonRecord } from "./records.js";
import { queryRows } from "./sqlite_rows.js";

const messageRow = z.object({ text: z.string().nullable() });

/**
 * The blobs of a legacy Cursor chat store that are messages: its rows are mixed binary, and a message is the JSON text
 * that begins `{"role":`. Only those are selected, in the order they were written.
 */
const MESSAGE_BLOBS =
  `SELECT CAST(data AS TEXT) AS text FROM blobs WHERE substr(CAST(data AS TEXT), 1, 8) = '{"role":' ORDER BY rowid`;

/** A store message `{role, content}` as the `{role, message: {content}}` record of an agent transcript. */
function asAgentRecord(message: JsonRecord): JsonRecord {
  const role = message.role === "human" ? "user" : message.role;
  return { role, message: { content: message.content } };
}

/**
 * The transcript of a session kept only in Cursor's older chat store, `~/.cursor/chats/<outer>/<id>/store.db`: its
 * user and assistant messages, read by the same rules as an agent transcript (system wrappers stripped, the ask
 * unwrapped) and the workspace its `<user_info>` block names. `path` is the store.
 */
export async function cursorLegacyTranscript(store: string, machine: HostMachine): Promise<Transcript> {
  const rows = await queryRows(machine, store, MESSAGE_BLOBS, messageRow);
  const turns: TranscriptTurn[] = [];
  let metadata: SessionMetadata = {};
  let skippedLines = 0;
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(row.text ?? "");
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(message)) {
      skippedLines += 1;
      continue;
    }
    const record = asAgentRecord(message);
    turns.push(...cursorRecordTurns(record));
    metadata = mergeMetadata(metadata, cursorRecordMetadata(record));
  }
  return { path: store, turns, skipped_lines: skippedLines, ...metadataEntry(metadata) };
}
