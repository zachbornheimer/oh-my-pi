/**
 * The write side of the session store `public.memory_chunks`: the idempotent DDL, and a batched upsert keyed on the
 * chunk id. Ported from the Mastra gateway's `memory/store.ts`.
 */
import type { Db } from "./db.js";
import { EMBEDDING_DIMENSION } from "./embed.js";

/** Rows per INSERT: the batch travels as one JSON parameter, so the statement text is static and no value is spliced into SQL. */
export const WRITE_BATCH = 50;

export const MEMORY_SCHEMA_STATEMENTS: readonly string[] = [
  `create table if not exists public.memory_chunks (
    id          text primary key,
    session_path text not null,
    source      text not null,
    repository  text,
    occurred_at timestamptz not null,
    chunk_index integer not null,
    body        text not null,
    tsv         tsvector generated always as (to_tsvector('english', body)) stored,
    embedding   vector(1536)
  )`,
  `create index if not exists memory_chunks_bm25 on public.memory_chunks using lakebase_bm25 (tsv)`,
  `create index if not exists memory_chunks_ann on public.memory_chunks using lakebase_ann (embedding vector_cosine_ops)`,
  `create index if not exists memory_chunks_path on public.memory_chunks (session_path)`,
  `create index if not exists memory_chunks_at on public.memory_chunks (occurred_at desc)`,
];

export interface MemoryChunkRow {
  id: string;
  sessionPath: string;
  source: string;
  repository?: string;
  /** ISO instant; the store requires one. */
  occurredAt: string;
  chunkIndex: number;
  body: string;
  embedding?: readonly number[];
}

/** Databases this process has already created the schema on, so an ingest pays for the DDL once. */
const schemaReady = new WeakSet<Db>();

/** Creates the table and its indexes when absent. */
export async function ensureMemorySchema(db: Db): Promise<void> {
  if (schemaReady.has(db)) return;
  for (const statement of MEMORY_SCHEMA_STATEMENTS) await db.query(statement);
  schemaReady.add(db);
}

/** A row's vector as the pg vector type reads it; `null` is a row the vector arm cannot see. */
function vectorLiteral(embedding: readonly number[] | undefined): string | null {
  if (embedding === undefined) return null;
  if (embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(`memory chunk embedding: ${embedding.length} values, the column holds ${EMBEDDING_DIMENSION}`);
  }
  return `[${embedding.join(",")}]`;
}

/**
 * Writes rows in batches, idempotent on the chunk id: a re-ingest replaces what it wrote and adds nothing. A row
 * written without a vector keeps the vector a previous ingest gave it, so a keyless re-run does not erase a column
 * the vector arm reads.
 */
export async function writeMemoryChunks(db: Db, rows: readonly MemoryChunkRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureMemorySchema(db);
  for (let start = 0; start < rows.length; start += WRITE_BATCH) {
    const batch = rows.slice(start, start + WRITE_BATCH);
    const payload = batch.map((row) => ({
      id: row.id,
      session_path: row.sessionPath,
      source: row.source,
      repository: row.repository ?? null,
      occurred_at: row.occurredAt,
      chunk_index: row.chunkIndex,
      body: row.body,
      embedding: vectorLiteral(row.embedding),
    }));
    await db.query(
      `insert into public.memory_chunks (id, session_path, source, repository, occurred_at, chunk_index, body, embedding)
       select r.id, r.session_path, r.source, r.repository, r.occurred_at::timestamptz, r.chunk_index, r.body, r.embedding::vector
       from jsonb_to_recordset($1::jsonb) as r(id text, session_path text, source text, repository text, occurred_at text, chunk_index integer, body text, embedding text)
       on conflict (id) do update set
         session_path = excluded.session_path,
         source = excluded.source,
         repository = excluded.repository,
         occurred_at = excluded.occurred_at,
         chunk_index = excluded.chunk_index,
         body = excluded.body,
         embedding = coalesce(excluded.embedding, public.memory_chunks.embedding)`,
      [JSON.stringify(payload)],
    );
  }
  return rows.length;
}

/**
 * Removes the chunks a shorter re-ingest of the same document left behind: rows under `sessionPath` past the last
 * chunk index just written. Without it an edited note would keep answering with its old tail.
 */
export async function dropStaleChunks(db: Db, sessionPath: string, keep: number): Promise<void> {
  await db.query("delete from public.memory_chunks where session_path = $1 and chunk_index >= $2", [sessionPath, keep]);
}
