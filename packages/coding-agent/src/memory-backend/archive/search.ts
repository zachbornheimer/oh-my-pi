/**
 * Recall over `public.memory_chunks`: a lexical arm over the generated tsvector, a cosine arm over
 * `embedding`, fused across four reciprocal-rank arms (`lexical_facts`, `lexical_chunks`,
 * `vector_facts`, `vector_chunks`), and optionally gated by Jev (`~typesafe/jev-latest`) over a
 * relevance threshold.
 *
 * Context is soft, never a filter. Every row carries the repository it came from and, when the
 * store has them, a working directory, a branch and the files the session edited. A row whose
 * repository is the one being worked in, or that names a file this session has touched, ranks
 * higher; nothing is ever excluded for belonging to another project.
 *
 * Both statements bind every value as a parameter and carry no interpolated text, so no count, id
 * or prompt fragment ever becomes SQL.
 */

import type { ArchiveClient } from "./client.js";

/** How many rows each arm hands to the fusion before it ranks. */
export const ARCHIVE_ARM_DEPTH = 40;
/** How many rows the caller gets back when it names no limit and no relevance judge is active. */
export const ARCHIVE_DEFAULT_LIMIT = 8;
/** The ceiling on candidates evaluated by Jev and returned by a single recall. */
export const ARCHIVE_MAX_LIMIT = 24;
/** Balanced shortlist size handed to Jev: top facts + top chunks so neither arm starves the other. */
export const ARCHIVE_JUDGE_SHORTLIST = 24;
/** Default Jev confidence threshold ([0, 1]) a candidate must clear to be injected. */
export const ARCHIVE_RELEVANCE_THRESHOLD = 0.65;
/** The reciprocal-rank constant. */
export const ARCHIVE_RRF_K = 60;
/** A distilled fact outranks a raw transcript chunk at equal rank. */
export const ARCHIVE_FACT_BOOST = 1.25;
/** A row from the repository being worked in outranks a stranger at equal rank. */
export const ARCHIVE_REPO_BOOST = 1.15;
/** A row that names one of the session's touched files outranks a stranger at equal rank. */
export const ARCHIVE_FILE_BOOST = 1.2;
/** A chunk's ceiling, so a hit shows the whole chunk a query matched in. */
export const ARCHIVE_EVIDENCE_CHARS = 4000;
/** Terms one query may carry into the lexical arm. */
const MAX_QUERY_TERMS = 48;
/**
 * How many recent raw chunks the lexical arm may rank over. Facts are few and are always ranked in
 * full; chunks are ranked over the newest window in the lexical arm and over the `memory_chunks_ann`
 * cosine index in the vector arm.
 */
export const ARCHIVE_CHUNK_WINDOW = 5000;

const LEXICAL_SQL = `with recent_chunks as materialized (
    select id, session_path, source, repository, scope, kind, occurred_at, body, tsv
      from public.memory_chunks
     where kind = 'chunk'
     order by occurred_at desc
     limit $2
  ),
  matched_facts as (
    select id, session_path, source, repository, scope, kind, occurred_at, body,
           ts_rank(tsv, to_tsquery('english', $1), 2) as rank
      from public.memory_chunks
     where kind = 'fact' and tsv @@ to_tsquery('english', $1)
     order by rank desc
     limit $3
  ),
  matched_chunks as (
    select id, session_path, source, repository, scope, kind, occurred_at, body,
           ts_rank(tsv, to_tsquery('english', $1), 33) as rank
      from recent_chunks
     where tsv @@ to_tsquery('english', $1)
     order by rank desc
     limit $3
  )
  select id, session_path, source, repository, scope, kind, occurred_at, body
    from (select * from matched_facts union all select * from matched_chunks) combined
   order by rank desc`;

/**
 * Two-tier vector query:
 *  - `vector_facts` scans all embedded facts via `memory_chunks_facts_scope_idx` (~31 ms) so the
 *    373k embedded chunks never crowd out the ~1.1k facts in ANN.
 *  - `vector_all` uses the `memory_chunks_ann` (`lakebase_ann`) index directly (~133 ms). Putting
 *    `where embedding is not null` on the full table disables `lakebase_ann` and forces a 2.8 s scan,
 *    so null distances are filtered on the outer union instead.
 */
const VECTOR_SQL = `with vector_facts as (
    select id, session_path, source, repository, scope, kind, occurred_at, body,
           (embedding <=> $1::vector) as rank
      from public.memory_chunks
     where kind = 'fact' and embedding is not null
     order by rank asc
     limit $2
  ),
  vector_all as (
    select id, session_path, source, repository, scope, kind, occurred_at, body,
           (embedding <=> $1::vector) as rank
      from public.memory_chunks
     order by embedding <=> $1::vector asc
     limit $2
  )
  select id, session_path, source, repository, scope, kind, occurred_at, body, rank
    from (select * from vector_facts union all select * from vector_all) combined
   where rank is not null
   order by rank asc`;

/** What the caller is working on, used only to order results. */
export interface ArchiveContext {
	cwd?: string;
	repository?: string;
	branch?: string;
	/** Files this session wrote or edited, as repo-relative or absolute paths. */
	files?: readonly string[];
}

export interface ArchiveHit {
	id: string;
	repository?: string;
	scope?: string;
	kind?: "fact" | "chunk";
	at: string;
	/** Absolute transcript path, or the source a fact was saved from. */
	source?: string;
	score: number;
	/** Calibrated [0, 1] Jev relevance probability when the judge ran. */
	confidence?: number;
	body: string;
}

/** Scores a shortlist of candidate hits against `query`, returning [0, 1] probabilities keyed by hit id. */
export type ArchiveJudge = (
	query: string,
	candidates: readonly ArchiveHit[],
	signal?: AbortSignal,
) => Promise<ReadonlyMap<string, number>>;

export interface ArchiveRecall {
	hits: ArchiveHit[];
	lexical: { used: boolean; count: number; reason?: string };
	vector: { used: boolean; count: number; reason?: string };
	judge?: { used: boolean; shortlisted: number; kept: number; threshold: number; reason?: string };
}

interface Row {
	id: string;
	session_path: string | null;
	source: string | null;
	repository: string | null;
	scope: string | null;
	kind: string | null;
	occurred_at: string | Date;
	body: string;
	rank?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The query as the lexical arm reads it: every term a lexeme, OR'd. Compound identifiers separated by
 * `_`, `-`, or `.` (e.g. `tool_search`, `ZYS-9082`, `linear.app`) also contribute their component words
 * so URLs and ticket keys match both the full token and its prefix/domain.
 */
export function archiveTermsOf(query: string): string {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9_+#.'\u2019-]*/g) ?? []) {
		const term = word.replace(/[.+#-]+$/, "").replace(/['\u2019]+$/, "");
		if (term.length < 2 && !/^[0-9]+$/.test(term)) continue;
		const subparts = /[_.-]/.test(term)
			? term.split(/[_.-]+/).filter((p) => p.length >= 2 || /^[0-9]+$/.test(p))
			: [];
		const parts = subparts.length > 0 ? [term, ...subparts] : [term];
		for (const part of parts) {
			if (seen.has(part)) continue;
			seen.add(part);
			terms.push(`'${part.replace(/'/g, "''")}'`);
			if (terms.length >= MAX_QUERY_TERMS) break;
		}
		if (terms.length >= MAX_QUERY_TERMS) break;
	}
	return terms.join(" | ");
}

/** Each arm votes `1 / (k + rank)`; duplicate ids inside a single arm are counted once at their best rank. */
export function archiveFuse(arms: readonly (readonly string[])[], k: number = ARCHIVE_RRF_K): Map<string, number> {
	const fused = new Map<string, number>();
	for (const arm of arms) {
		const seen = new Set<string>();
		let rank = 0;
		for (const id of arm) {
			if (seen.has(id)) continue;
			seen.add(id);
			fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1));
			rank += 1;
		}
	}
	return fused;
}

/** The context multiplier for one row: repository first, then a touched file named in its body. */
export function archiveContextBoost(row: ArchiveHit, context: ArchiveContext): number {
	let boost = 1;
	if (context.repository !== undefined && row.repository !== undefined && row.repository === context.repository) {
		boost *= ARCHIVE_REPO_BOOST;
	}
	if (context.files !== undefined && context.files.length > 0) {
		const body = row.body.toLowerCase();
		for (const file of context.files) {
			const normalized = file.toLowerCase();
			const tail = normalized.split("/").slice(-2).join("/");
			if (body.includes(normalized) || (tail.length > 3 && body.includes(tail))) {
				boost *= ARCHIVE_FILE_BOOST;
				break;
			}
		}
	}
	return boost;
}

const instantOf = (value: Date | string): string =>
	value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export interface RecallOptions {
	limit?: number;
	signal?: AbortSignal;
	/** Query embeddings; absent means the vector arm does not run. */
	embed?: (query: string, signal?: AbortSignal) => Promise<readonly number[] | undefined>;
	/** Relevance judge (Jev); when provided, keeps all candidates clearing `threshold`. */
	judge?: ArchiveJudge;
	/** Minimum Jev confidence ([0, 1]) to keep a candidate when `judge` is provided. Default 0.65. */
	threshold?: number;
	/** Raw chunks the lexical arm ranks over; the newest by `occurred_at`. */
	chunkWindow?: number;
}

async function lexicalArm(
	client: ArchiveClient,
	terms: string,
	depth: number,
	chunkWindow: number,
): Promise<{ rows: Row[]; used: boolean; reason?: string }> {
	if (terms === "") return { rows: [], used: false, reason: "no searchable term in the query" };
	try {
		const rows = await client.query<Row>(LEXICAL_SQL, [terms, chunkWindow, depth]);
		return { rows, used: true };
	} catch (error) {
		return { rows: [], used: false, reason: messageOf(error) };
	}
}

async function vectorArm(
	client: ArchiveClient,
	vector: readonly number[] | undefined,
	depth: number,
): Promise<{ rows: Row[]; used: boolean; reason?: string }> {
	if (vector === undefined) return { rows: [], used: false, reason: "no embedding provider in this process" };
	try {
		const rows = await client.query<Row>(VECTOR_SQL, [`[${vector.join(",")}]`, depth]);
		return { rows, used: true };
	} catch (error) {
		return { rows: [], used: false, reason: messageOf(error) };
	}
}

const asHit = (row: Row, score: number): ArchiveHit => ({
	id: row.id,
	...(row.repository === null ? {} : { repository: row.repository }),
	...(row.scope === null ? {} : { scope: row.scope }),
	...(row.kind === "fact" || row.kind === "chunk" ? { kind: row.kind } : {}),
	at: instantOf(row.occurred_at),
	...(row.session_path === null && row.source === null ? {} : { source: row.session_path ?? row.source ?? undefined }),
	score: Number(score.toFixed(6)),
	body: row.body.length <= ARCHIVE_EVIDENCE_CHARS ? row.body : `${row.body.slice(0, ARCHIVE_EVIDENCE_CHARS)}…`,
});

/** Balanced shortlist of up to `max` hits so single-arm facts cannot crowd out top chunks before Jev judges them. */
export function buildJudgeShortlist(hits: readonly ArchiveHit[], max: number = ARCHIVE_JUDGE_SHORTLIST): ArchiveHit[] {
	if (hits.length <= max) return [...hits];
	const factQuota = Math.ceil(max * 0.58);
	const chunkQuota = max - factQuota;
	const topFacts = hits.filter((hit) => hit.kind === "fact").slice(0, factQuota);
	const topChunks = hits.filter((hit) => hit.kind !== "fact").slice(0, chunkQuota);
	const picked = new Set<string>([...topFacts, ...topChunks].map((hit) => hit.id));
	const combined = [...topFacts, ...topChunks];
	for (const hit of hits) {
		if (combined.length >= max) break;
		if (!picked.has(hit.id)) {
			picked.add(hit.id);
			combined.push(hit);
		}
	}
	return combined;
}

/**
 * The evidence closest to the query, ordered by 4-arm reciprocal rank, the fact weight, the soft
 * context weight, and (when `options.judge` is supplied) Jev relevance probability above `threshold`.
 * When `options.judge` is active and no explicit `limit` is passed, every candidate clearing
 * `threshold` is returned rather than capping at 5.
 */
export async function archiveRecall(
	client: ArchiveClient,
	query: string,
	context: ArchiveContext,
	options: RecallOptions = {},
): Promise<ArchiveRecall> {
	const trimmed = query.trim();
	const explicitLimit =
		options.limit === undefined
			? undefined
			: Math.min(Math.max(Math.floor(options.limit), 1), ARCHIVE_MAX_LIMIT);
	const limit = explicitLimit ?? ARCHIVE_DEFAULT_LIMIT;
	if (trimmed === "") {
		const reason = "empty query";
		return { hits: [], lexical: { used: false, count: 0, reason }, vector: { used: false, count: 0, reason } };
	}
	if (
		trimmed.includes("<memories>") ||
		trimmed.includes("<memories ") ||
		trimmed.includes('source="extension/onUserPromptSubmit"')
	) {
		const reason = "recalled by onUserPromptSubmit";
		return { hits: [], lexical: { used: false, count: 0, reason }, vector: { used: false, count: 0, reason } };
	}
	const depth = Math.max(limit, ARCHIVE_ARM_DEPTH);
	const chunkWindow = Math.max(1, Math.floor(options.chunkWindow ?? ARCHIVE_CHUNK_WINDOW));

	let queryVector: readonly number[] | undefined;
	let vectorReason: string | undefined;
	if (options.embed) {
		try {
			queryVector = await options.embed(trimmed, options.signal);
		} catch (error) {
			vectorReason = messageOf(error);
		}
	}
	const [lexical, vector] = await Promise.all([
		lexicalArm(client, archiveTermsOf(trimmed), depth, chunkWindow),
		vectorArm(client, queryVector, depth),
	]);
	const rows = new Map<string, Row>();
	for (const row of [...lexical.rows, ...vector.rows]) if (!rows.has(row.id)) rows.set(row.id, row);

	const fused = archiveFuse([
		lexical.rows.filter((row) => row.kind === "fact").map((row) => row.id),
		lexical.rows.filter((row) => row.kind !== "fact").map((row) => row.id),
		vector.rows.filter((row) => row.kind === "fact").map((row) => row.id),
		vector.rows.filter((row) => row.kind !== "fact").map((row) => row.id),
	]);
	const hits: ArchiveHit[] = [];
	for (const [id, rawScore] of fused) {
		const row = rows.get(id);
		if (row === undefined) continue;
		const hit = asHit(row, rawScore);
		const weighted = rawScore * (hit.kind === "fact" ? ARCHIVE_FACT_BOOST : 1) * archiveContextBoost(hit, context);
		hits.push({ ...hit, score: Number(weighted.toFixed(6)) });
	}
	hits.sort((left, right) => right.score - left.score || right.at.localeCompare(left.at));

	if (options.judge && hits.length > 0) {
		const threshold = options.threshold ?? ARCHIVE_RELEVANCE_THRESHOLD;
		const shortlist = buildJudgeShortlist(hits, ARCHIVE_JUDGE_SHORTLIST);
		try {
			const scores = await options.judge(trimmed, shortlist, options.signal);
			const kept = shortlist
				.map((hit) => {
					const confidence = scores.get(hit.id);
					return confidence === undefined
						? undefined
						: { ...hit, confidence: Number(confidence.toFixed(5)) };
				})
				.filter((hit): hit is ArchiveHit & { confidence: number } => hit !== undefined && hit.confidence >= threshold)
				.sort((left, right) => right.confidence - left.confidence || right.score - left.score || right.at.localeCompare(left.at));
			const finalHits = explicitLimit === undefined ? kept : kept.slice(0, explicitLimit);
			return {
				hits: finalHits,
				lexical: {
					used: lexical.used,
					count: lexical.rows.length,
					...(lexical.reason === undefined ? {} : { reason: lexical.reason }),
				},
				vector: {
					used: vector.used,
					count: vector.rows.length,
					...(vector.used ? {} : { reason: vectorReason ?? vector.reason }),
				},
				judge: {
					used: true,
					shortlisted: shortlist.length,
					kept: finalHits.length,
					threshold,
				},
			};
		} catch (error) {
			return {
				hits: hits.slice(0, limit),
				lexical: {
					used: lexical.used,
					count: lexical.rows.length,
					...(lexical.reason === undefined ? {} : { reason: lexical.reason }),
				},
				vector: {
					used: vector.used,
					count: vector.rows.length,
					...(vector.used ? {} : { reason: vectorReason ?? vector.reason }),
				},
				judge: {
					used: false,
					shortlisted: shortlist.length,
					kept: 0,
					threshold,
					reason: messageOf(error),
				},
			};
		}
	}

	return {
		hits: hits.slice(0, limit),
		lexical: {
			used: lexical.used,
			count: lexical.rows.length,
			...(lexical.reason === undefined ? {} : { reason: lexical.reason }),
		},
		vector: {
			used: vector.used,
			count: vector.rows.length,
			...(vector.used ? {} : { reason: vectorReason ?? vector.reason }),
		},
	};
}

/** The injected memory block: all hits that fit inside `budgetChars`, or undefined when nothing matched. */
export function archiveContextBlock(hits: readonly ArchiveHit[], budgetChars = 8000): string | undefined {
	if (hits.length === 0) return undefined;
	const escapeXml = (value: string): string =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const lines: string[] = [];
	let used = 0;
	for (const hit of hits) {
		const relevance = Number((hit.confidence ?? hit.score).toFixed(5));
		const text = escapeXml(hit.body.replace(/\s+/g, " ").trim());
		const clipped = text.length > 320 ? `${text.slice(0, 320)}…` : text;
		const line = `<memory relevance="${relevance}">${clipped}</memory>`;
		if (used + line.length + 1 > budgetChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return undefined;
	return ["<memories>", ...lines, "</memories>"].join("\n");
}

/** True when this row came from the same repository the caller is in. Exported for tests. */
export const sameRepository = (row: ArchiveHit, context: ArchiveContext): boolean =>
	context.repository !== undefined && row.repository === context.repository;
