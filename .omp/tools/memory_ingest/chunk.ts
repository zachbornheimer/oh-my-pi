import { createHash } from "node:crypto";

/** A chunk's ceiling: past this one document becomes several, so no embedding request carries an unbounded body. */
export const MAX_CHUNK_CHARS = 4000;

export interface DocumentChunk {
  /** Stable across re-runs: source, document name and piece number, so a re-ingest replaces, never duplicates. */
  id: string;
  text: string;
}

/** A chunk's id: the first 32 hex characters of the SHA-1 of `source:session:slot`, the scheme the session chunker uses. */
export function idOf(source: string, session: string, slot: string): string {
  return createHash("sha1").update(`${source}:${session}:${slot}`).digest("hex").slice(0, 32);
}

/**
 * The chunks of one document that carries no records of its own (a note, a pasted report, a settled decision): the
 * trimmed body cut every `MAX_CHUNK_CHARS` characters. Ported from the Mastra gateway's `chunkDocument`.
 */
export function chunkDocument(text: string, source: string, name: string): DocumentChunk[] {
  const body = text.trim();
  if (body === "") return [];
  const chunks: DocumentChunk[] = [];
  for (let offset = 0; offset < body.length; offset += MAX_CHUNK_CHARS) {
    chunks.push({ id: idOf(source, name, String(offset / MAX_CHUNK_CHARS)), text: body.slice(offset, offset + MAX_CHUNK_CHARS) });
  }
  return chunks;
}
