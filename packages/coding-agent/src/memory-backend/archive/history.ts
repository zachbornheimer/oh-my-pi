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
 * Copies the given current fact rows into history. `history_id` is a content hash, so a retry after
 * a crash between this copy and the rewrite inserts nothing twice.
 */
export const ARCHIVE_FACTS_TO_HISTORY_SQL = `insert into public.memory_fact_history
    (history_id, id, source, session_path, repository, scope, occurred_at, body, embedding, superseded_by, superseded_at)
  select md5(id || '|' || occurred_at::text || '|' || body), id, source, session_path, repository, scope,
         occurred_at, body, embedding, $2, $3::timestamptz
    from public.memory_chunks
   where kind = 'fact' and id = any($1::text[])
  on conflict (history_id) do nothing`;

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

/** Copies `ids` (current fact rows) into history as superseded by `supersededBy` at `supersededAt`. */
export async function archiveFactsToHistory(
	client: ArchiveClient,
	ids: readonly string[],
	supersededBy: string,
	supersededAt: string,
): Promise<void> {
	await client.query(ARCHIVE_FACTS_TO_HISTORY_SQL, [`{${ids.join(",")}}`, supersededBy, supersededAt]);
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
