/**
 * Recall over the session store `public.memory_chunks`: a BM25 arm over the generated tsvector and a cosine arm over
 * `embedding`, fused by reciprocal rank. The result is evidence — each chunk's own words plus the session file,
 * instant and repository that cite it — never a summary. BM25 needs no key, so a process with no embedding provider
 * still recalls and the vector arm reports itself absent; a store that cannot be reached answers as an empty
 * result that names its cause. Ported from the Mastra gateway's `memory/store.ts` and `memory/recall.ts`.
 */
import type { Db } from "./db.js";
import { EMBEDDING_DIMENSION, type Embedder } from "./embed.js";

/** How many chunks a search returns when `limit` is omitted. */
export const MEMORY_SEARCH_LIMIT = 20;
export const MAX_LIMIT = 50;
/** How many rows each arm hands to the fusion before it ranks. */
export const ARM_DEPTH = 40;
/** The reciprocal-rank constant: agreement between arms beats one arm's top hit, and no raw score scale leaks into the order. */
export const RRF_K = 60;
/** Terms one query may carry into the BM25 arm. */
const MAX_QUERY_TERMS = 24;
/** A chunk's ceiling (the chunker's own), so a hit shows the whole chunk a query matched in. */
export const EVIDENCE_CHARS = 4000;
export const MEMORY_BM25_INDEX = "public.memory_chunks_bm25";

export interface ArmReport {
  used: boolean;
  count: number;
  reason?: string;
}

export interface Evidence {
  id: string;
  score: number;
  source: string;
  session: string;
  at: string;
  repository?: string;
  text: string;
}

export interface RecallOutcome {
  evidence: Evidence[];
  arms: { bm25: ArmReport; vector: ArmReport };
  degraded?: boolean;
  reason?: string;
}

export interface RecallRequest {
  query: string;
  limit?: number;
  repository?: string;
  /** ISO instant: read the store as it stood then, newest first. */
  asOf?: string;
}

export interface RecallDeps {
  /** The store; absent means the connection could not be made, and `storeFailure` says why. */
  db?: Db;
  storeFailure?: string;
  /** Embeds the query; absent means no vector arm, and `embedderFailure` may say why. */
  embed?: Embedder;
  embedderFailure?: string;
  signal?: AbortSignal;
}

interface Row {
  id: string;
  session_path: string;
  source: string;
  repository: string | null;
  occurred_at: Date | string;
  body: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The query as the BM25 arm reads it: every term a lexeme, OR'd. AND semantics return nothing for a question, and
 * substrings match nothing at all, so the terms are OR'd and the ranking decides.
 */
export function termsOf(query: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9_+#.-]*/g) ?? []) {
    const term = word.replace(/[.+#-]+$/, "");
    if (term.length < 2 && !/^[0-9]+$/.test(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(`'${term.replace(/'/g, "''")}'`);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms.join(" | ");
}

/** Each arm votes `1 / (k + rank)`; the sum is the score. The best id of an arm is rank 1. */
export function fuseByReciprocalRank(arms: readonly (readonly string[])[], k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const arm of arms) {
    for (const [index, id] of arm.entries()) fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
  }
  return fused;
}

interface Filters {
  repository?: string;
  asOf?: string;
  limit: number;
}

/** The repository filter and as-of clamp both arms share; `first` is the arm's first free placeholder. */
function armFilters(filters: Filters, first: number): { clause: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (filters.repository !== undefined) {
    values.push(filters.repository);
    parts.push(`repository = $${first + values.length - 1}`);
  }
  if (filters.asOf !== undefined) {
    values.push(filters.asOf);
    // Cast because values go untyped: without it Postgres compares a timestamptz against a text parameter.
    parts.push(`occurred_at <= $${first + values.length - 1}::timestamptz`);
  }
  return { clause: parts.length === 0 ? "" : ` and ${parts.join(" and ")}`, values };
}

const instantOf = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

async function bm25Arm(db: Db, terms: string, filters: Filters): Promise<{ rows: Row[]; report: ArmReport }> {
  if (terms === "") return { rows: [], report: { used: false, count: 0, reason: "no searchable term in the query" } };
  const { clause, values } = armFilters(filters, 2);
  try {
    const result = await db.query(
      `select id, session_path, source, repository, occurred_at, chunk_index, body
         from public.memory_chunks
        where tsv @@ to_tsquery('english', $1)${clause}
        order by tsv <@> to_bm25query(tsv, '${MEMORY_BM25_INDEX}'::regclass)
        limit ${filters.limit}`,
      [terms, ...values],
    );
    return { rows: result.rows as unknown as Row[], report: { used: true, count: result.rows.length } };
  } catch (error) {
    return { rows: [], report: { used: false, count: 0, reason: messageOf(error) } };
  }
}

async function vectorArm(db: Db, queryVector: readonly number[] | undefined, filters: Filters): Promise<{ rows: Row[]; report: ArmReport }> {
  if (queryVector === undefined) {
    return { rows: [], report: { used: false, count: 0, reason: "no embedding provider in this process: the vector arm did not run" } };
  }
  const { clause, values } = armFilters(filters, 1);
  try {
    const result = await db.query(
      `select id, session_path, source, repository, occurred_at, chunk_index, body
         from public.memory_chunks
        where embedding is not null${clause}
        order by embedding <=> $${values.length + 1}::vector
        limit ${filters.limit}`,
      [...values, `[${queryVector.join(",")}]`],
    );
    return { rows: result.rows as unknown as Row[], report: { used: true, count: result.rows.length } };
  } catch (error) {
    return { rows: [], report: { used: false, count: 0, reason: messageOf(error) } };
  }
}

const noArms = (reason: string): { bm25: ArmReport; vector: ArmReport } => ({
  bm25: { used: false, count: 0, reason },
  vector: { used: false, count: 0, reason },
});

/**
 * The evidence closest to the query. Never throws for a missing key, a refused embedding or an unreachable store:
 * each answers as an empty result that names its cause. An as-of read clamps to what was known by then and returns
 * the newest of it first, which is what answers a supersession question.
 */
export async function recallMemory(request: RecallRequest, deps: RecallDeps): Promise<RecallOutcome> {
  const query = request.query.trim();
  if (query === "") return { evidence: [], arms: noArms("empty query"), degraded: true, reason: "empty query" };
  const limit = request.limit ?? MEMORY_SEARCH_LIMIT;
  if (deps.db === undefined) {
    const reason = deps.storeFailure ?? "the session store is not reachable";
    return { evidence: [], arms: noArms(reason), degraded: true, reason };
  }
  deps.signal?.throwIfAborted();

  // A failed embedding is one arm's absence, not the read's: the BM25 arm still ranks this query.
  let queryVector: number[] | undefined;
  let vectorAbsentReason = deps.embedderFailure;
  if (deps.embed !== undefined) {
    try {
      const [vector] = await deps.embed([query], deps.signal);
      if (vector === undefined || vector.length !== EMBEDDING_DIMENSION) throw new Error("the embedder returned no usable vector");
      queryVector = vector;
    } catch (error) {
      deps.signal?.throwIfAborted();
      vectorAbsentReason = messageOf(error);
    }
  }

  try {
    const filters: Filters = {
      limit: Math.max(limit, ARM_DEPTH),
      ...(request.repository === undefined ? {} : { repository: request.repository }),
      ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
    };
    const [bm25, vector] = await Promise.all([bm25Arm(deps.db, termsOf(query), filters), vectorArm(deps.db, queryVector, filters)]);
    const rows = new Map<string, Row>();
    for (const row of [...bm25.rows, ...vector.rows]) if (!rows.has(row.id)) rows.set(row.id, row);
    const fused = fuseByReciprocalRank([bm25.rows.map((row) => row.id), vector.rows.map((row) => row.id)]);
    const evidence: Evidence[] = [];
    for (const [id, score] of fused) {
      const row = rows.get(id);
      if (row === undefined) continue;
      evidence.push({
        id: row.id,
        score: Number(score.toFixed(6)),
        source: row.source,
        session: row.session_path,
        at: instantOf(row.occurred_at),
        ...(row.repository === null || row.repository === undefined ? {} : { repository: row.repository }),
        text: row.body.length <= EVIDENCE_CHARS ? row.body : `${row.body.slice(0, EVIDENCE_CHARS)}…`,
      });
    }
    evidence.sort((left, right) =>
      request.asOf === undefined
        ? right.score - left.score || right.at.localeCompare(left.at)
        : right.at.localeCompare(left.at) || right.score - left.score,
    );
    // The store cannot know why the vector was missing: when the embedder was here and failed, or could not be built,
    // that is the arm's reason.
    const arms = {
      bm25: bm25.report,
      vector:
        vectorAbsentReason === undefined || vector.report.used
          ? vector.report
          : { ...vector.report, used: false, reason: `the vector arm did not run: ${vectorAbsentReason}` },
    };
    const degraded = !arms.bm25.used && !arms.vector.used;
    return {
      evidence: evidence.slice(0, limit),
      arms,
      ...(degraded ? { degraded: true, reason: arms.bm25.reason ?? arms.vector.reason ?? "no arm ran" } : {}),
    };
  } catch (error) {
    const reason = messageOf(error);
    return { evidence: [], arms: noArms(reason), degraded: true, reason };
  }
}
