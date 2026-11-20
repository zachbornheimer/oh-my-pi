/**
 * Non-destructive supersession for `kind = 'fact'` rows in `public.memory_chunks`.
 *
 * Consolidation rewrites one row (the canonical, newest fact) and removes the rest from
 * `memory_chunks`, so current recall (`search.ts`) keeps returning only the replacement. Before it
 * does, every input row is copied whole into `public.memory_fact_history` with the id of the
 * replacement (`superseded_by`) and the instant it took over (`superseded_at`). The canonical row's
 * own pre-merge version is copied too, because the rewrite overwrites its body. Nothing is lost: the
 * old source ids, bodies, sessions and embeddings stay queryable through `archiveFactsAsOf`.
 */

import type { ArchiveClient } from "./client.js";

/** Default row cap for one as-of query. */
export const ARCHIVE_ASOF_DEFAULT_LIMIT = 200;

export const CREATE_FACT_HISTORY_SQL = `create table if not exists public.memory_fact_history (
    history_id text primary key,
    id text not null,
    source text,
    session_path text,
    repository text,
    scope text,
    occurred_at timestamptz not null,
    body text not null,
    embedding vector,
    superseded_by text not null,
    superseded_at timestamptz not null
  )`;

export const CREATE_FACT_HISTORY_INDEX_SQL = `create index if not exists memory_fact_history_superseded_by_idx
    on public.memory_fact_history (superseded_by, superseded_at)`;

/**
 * One atomic statement (the client has no transaction): copies every input row, canonical included,
 * into history; rewrites the canonical row; deletes the other inputs. All three CTEs read the same
 * snapshot, so the copy captures the canonical's pre-merge text. `history_id` hashes the row's content
 * and its replacement, so a retry inserts nothing twice.
 *   $1 all input ids (canonical included), $2 canonical id, $3 superseded_at, $4 body, $5 embedding,
 *   $6 occurred_at, $7 source. The delete is every id in $1 except $2, so the canonical is never deleted.
 */
export const SUPERSEDE_FACTS_SQL = `with moved as (
    insert into public.memory_fact_history
      (history_id, id, source, session_path, repository, scope, occurred_at, body, embedding, superseded_by, superseded_at)
    select md5(concat_ws('|', id, occurred_at::text, body, $2::text)), id, source, session_path,
           repository, scope, occurred_at, body, embedding, $2::text, $3::timestamptz
      from public.memory_chunks
     where kind = 'fact' and id = any($1::text[])
    on conflict (history_id) do nothing
  ),
  rewritten as (
    update public.memory_chunks
       set body = $4, embedding = $5::vector, occurred_at = $6::timestamptz, source = $7
     where id = $2 and kind = 'fact'
  )
  delete from public.memory_chunks
   where kind = 'fact' and id = any($1::text[]) and id <> $2::text`;

/**
 * Facts as the store knew them at `$1`: current rows that already existed and were not yet rewritten
 * by a consolidation after `$1`, plus history rows live at `$1`. Optional `$2` repository and `$3`
 * scope filters; `$4` caps the rows.
 */
export const FACTS_AS_OF_SQL = `select id, source, session_path, repository, scope, occurred_at, body
    from (
      select c.id, c.source, c.session_path, c.repository, c.scope, c.occurred_at, c.body
        from public.memory_chunks c
       where c.kind = 'fact'
         and c.occurred_at <= $1::timestamptz
         and not exists (
           select 1 from public.memory_fact_history h
            where h.superseded_by = c.id and h.superseded_at > $1::timestamptz)
      union all
      select h.id, h.source, h.session_path, h.repository, h.scope, h.occurred_at, h.body
        from public.memory_fact_history h
       where h.occurred_at <= $1::timestamptz and h.superseded_at > $1::timestamptz
    ) as_of
   where ($2::text is null or repository = $2)
     and ($3::text is null or scope = $3)
   order by occurred_at desc, id asc
   limit $4`;

export interface ArchiveAsOfFact {
	id: string;
	source: string | null;
	session_path: string | null;
	repository: string | null;
	scope: string | null;
	occurred_at: string | Date;
	body: string;
}

export interface ArchiveAsOfOptions {
	repository?: string;
	scope?: string;
	limit?: number;
}

/** Creates the history table when absent. Idempotent. */
export async function archiveEnsureFactHistory(client: ArchiveClient): Promise<void> {
	await client.query(CREATE_FACT_HISTORY_SQL);
	await client.query(CREATE_FACT_HISTORY_INDEX_SQL);
}

export interface ArchiveSupersession {
	/** The surviving row, rewritten to `body`. */
	canonicalId: string;
	/** Rows the canonical replaces; they leave the current set. */
	supersededIds: readonly string[];
	body: string;
	/** Embedding of `body`, as a pgvector literal. */
	vector: string;
	occurredAt: string;
	source: string;
	supersededAt: string;
}

/** Records the old versions in history, rewrites the canonical and removes the rest, atomically. */
export async function archiveSupersedeFacts(client: ArchiveClient, change: ArchiveSupersession): Promise<void> {
	await client.query(SUPERSEDE_FACTS_SQL, [
		`{${[change.canonicalId, ...change.supersededIds].join(",")}}`,
		change.canonicalId,
		change.supersededAt,
		change.body,
		change.vector,
		change.occurredAt,
		change.source,
	]);
}

/** The facts valid at `asOf`, newest first; the version a later consolidation replaced is returned as it was. */
export async function archiveFactsAsOf(
	client: ArchiveClient,
	asOf: Date | string,
	options: ArchiveAsOfOptions = {},
): Promise<ArchiveAsOfFact[]> {
	const instant = asOf instanceof Date ? asOf.toISOString() : new Date(asOf).toISOString();
	const limit = Math.max(1, Math.floor(options.limit ?? ARCHIVE_ASOF_DEFAULT_LIMIT));
	return client.query<ArchiveAsOfFact>(FACTS_AS_OF_SQL, [
		instant,
		options.repository ?? null,
		options.scope ?? null,
		limit,
	]);
}
