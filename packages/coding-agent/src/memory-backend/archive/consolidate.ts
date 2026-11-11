/**
 * Lazy daily consolidation of `kind = 'fact'` rows in `public.memory_chunks`.
 *
 * Why lazy background consolidation beats write-time overwrite:
 *  - Separate `retain` / `learn` calls across a session (or across related sessions) record
 *    complementary details (e.g. an AWS instance ID in turn 5 and a Tailscale IP in turn 25).
 *    Overwriting on write drops whichever detail was only in the earlier fact.
 *  - Connected-component clustering over cosine similarity (`1 - (a.embedding <=> b.embedding) >= 0.86`)
 *    groups multi-fact chains (2–8 facts) across all `kind = 'fact'` rows and hands each
 *    chronological cluster to Haiku (`anthropic/claude-haiku-4.5`), which merges them into one
 *    canonical fact preserving every identifier, path, IP, SHA, command, and number while resolving
 *    contradictions to the newest timestamp.
 *  - Computing all-pairs dot products over `Float32Array` embeddings in memory takes ~1.2 s for
 *    1,100+ facts, avoiding a quadratic Postgres nested-loop scan over TOASTed vectors.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ArchiveClient } from "./client.js";
import { openArchiveEmbedder, openArchiveHaikuCombiner, type ArchiveFactCombiner } from "./openrouter.js";

/** Minimum cosine similarity (`1 - cosine_distance`) for two facts to link into the same cluster. */
export const ARCHIVE_CONSOLIDATE_SIMILARITY = 0.86;
/** Maximum facts combined in a single Haiku pass so the prompt stays bounded. */
export const ARCHIVE_CONSOLIDATE_MAX_CLUSTER = 8;
/** Parallel Haiku + embedding workers during a consolidation sweep. */
export const ARCHIVE_CONSOLIDATE_CONCURRENCY = 5;
/** Minimum interval between automatic background consolidations (24 hours). */
export const ARCHIVE_CONSOLIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const ALL_EMBEDDED_FACTS_SQL = `select id, embedding::text as embedding
    from public.memory_chunks
   where kind = 'fact' and embedding is not null
   order by occurred_at asc, id asc`;

const CLUSTER_FACTS_SQL = `select id, source, session_path, repository, scope, occurred_at, body
    from public.memory_chunks
   where kind = 'fact' and id = any($1::text[])
   order by occurred_at asc, id asc`;

const UPDATE_CANONICAL_FACT_SQL = `update public.memory_chunks
     set body = $2,
         embedding = $3::vector,
         occurred_at = $4::timestamptz,
         source = $5
   where id = $1 and kind = 'fact'`;

const DELETE_SUPERSEDED_FACTS_SQL = `delete from public.memory_chunks
   where kind = 'fact' and id = any($1::text[])`;

export interface ArchiveSimilarityEdge {
	id1: string;
	id2: string;
	similarity?: number;
}

export interface ArchiveEmbeddedFactRow {
	id: string;
	embedding: string | readonly number[];
}

export interface ArchiveFactRow {
	id: string;
	source: string | null;
	session_path: string | null;
	repository: string | null;
	scope: string | null;
	occurred_at: string | Date;
	body: string;
}

export interface ArchiveClusterReport {
	canonicalId: string;
	supersededIds: string[];
	inputCount: number;
	inputChars: number;
	outputChars: number;
	combinedBody: string;
}

export interface ArchiveConsolidateOptions {
	client: ArchiveClient;
	/** Minimum cosine similarity in (0, 1]. Default 0.86. */
	similarity?: number;
	/** Maximum clusters to process in one run. */
	maxClusters?: number;
	/** Concurrent cluster merges (default 5). */
	concurrency?: number;
	dryRun?: boolean;
	combine?: ArchiveFactCombiner;
	embed?: (text: string, signal?: AbortSignal) => Promise<readonly number[] | undefined>;
	signal?: AbortSignal;
}

export interface ArchiveConsolidateReport {
	dryRun: boolean;
	edgesFound: number;
	clustersFound: number;
	clustersConsolidated: number;
	factsMerged: number;
	factsRemoved: number;
	inputCharsTotal: number;
	outputCharsTotal: number;
	failed: number;
	clusters: ArchiveClusterReport[];
}

function parseVector(raw: string | readonly number[]): Float32Array | undefined {
	if (typeof raw !== "string") {
		return raw.length > 0 ? new Float32Array(raw) : undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed) && parsed.length > 0) {
			return new Float32Array(parsed as number[]);
		}
	} catch {
		// Malformed vector text.
	}
	return undefined;
}

/**
 * Computes all-pairs cosine similarity edges (`dot >= similarity`) in memory over normalized
 * `Float32Array` embeddings (~1.2 s for 1,100+ 1536-dim vectors).
 */
export function archiveFindSimilarityEdges(
	rows: readonly ArchiveEmbeddedFactRow[],
	similarity: number = ARCHIVE_CONSOLIDATE_SIMILARITY,
): ArchiveSimilarityEdge[] {
	const parsed: { id: string; vec: Float32Array }[] = [];
	for (const row of rows) {
		const vec = parseVector(row.embedding);
		if (vec) parsed.push({ id: row.id, vec });
	}
	const edges: ArchiveSimilarityEdge[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const left = parsed[i]!;
		const vLeft = left.vec;
		const len = vLeft.length;
		for (let j = i + 1; j < parsed.length; j++) {
			const right = parsed[j]!;
			const vRight = right.vec;
			if (vRight.length !== len) continue;
			let dot = 0;
			for (let k = 0; k < len; k++) {
				dot += vLeft[k]! * vRight[k]!;
			}
			if (dot >= similarity) {
				edges.push({ id1: left.id, id2: right.id, similarity: Number(dot.toFixed(4)) });
			}
		}
	}
	return edges;
}

/**
 * Pure connected-components clustering over similarity edges. Bounds each returned cluster to
 * `maxClusterSize` so an overly broad chain cannot exceed the combiner's token window.
 */
export function archiveClusterFacts(
	edges: readonly ArchiveSimilarityEdge[],
	maxClusterSize: number = ARCHIVE_CONSOLIDATE_MAX_CLUSTER,
): string[][] {
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		const current = parent.get(id);
		if (current === undefined) {
			parent.set(id, id);
			return id;
		}
		if (current !== id) {
			const root = find(current);
			parent.set(id, root);
			return root;
		}
		return current;
	};
	for (const edge of edges) {
		if (edge.id1 === edge.id2) continue;
		const r1 = find(edge.id1);
		const r2 = find(edge.id2);
		if (r1 !== r2) parent.set(r2, r1);
	}
	const grouped = new Map<string, string[]>();
	for (const id of parent.keys()) {
		const root = find(id);
		const list = grouped.get(root);
		if (list) list.push(id);
		else grouped.set(root, [id]);
	}
	const clusters: string[][] = [];
	for (const ids of grouped.values()) {
		if (ids.length < 2) continue;
		for (let offset = 0; offset < ids.length; offset += maxClusterSize) {
			const slice = ids.slice(offset, offset + maxClusterSize);
			if (slice.length >= 2) clusters.push(slice);
		}
	}
	return clusters;
}

const instantOf = (value: Date | string): string =>
	value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Finds connected components of similar `kind = 'fact'` rows across the entire store, merges each
 * cluster into one canonical fact via Haiku, updates the newest row in the cluster, and deletes the
 * older rows.
 */
export async function archiveConsolidateFacts(
	options: ArchiveConsolidateOptions,
): Promise<ArchiveConsolidateReport> {
	const similarity = Math.min(Math.max(options.similarity ?? ARCHIVE_CONSOLIDATE_SIMILARITY, 0.5), 0.999);
	const dryRun = options.dryRun === true;
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? ARCHIVE_CONSOLIDATE_CONCURRENCY));
	const combine = options.combine ?? openArchiveHaikuCombiner();
	const embed = options.embed ?? openArchiveEmbedder();

	const embeddedRows = await options.client.query<ArchiveEmbeddedFactRow>(ALL_EMBEDDED_FACTS_SQL);
	const edges = archiveFindSimilarityEdges(embeddedRows, similarity);
	const allClusters = archiveClusterFacts(edges);
	const targetClusters =
		options.maxClusters === undefined ? allClusters : allClusters.slice(0, Math.max(0, options.maxClusters));

	const report: ArchiveConsolidateReport = {
		dryRun,
		edgesFound: edges.length,
		clustersFound: allClusters.length,
		clustersConsolidated: 0,
		factsMerged: 0,
		factsRemoved: 0,
		inputCharsTotal: 0,
		outputCharsTotal: 0,
		failed: 0,
		clusters: [],
	};

	const processOneCluster = async (clusterIds: string[]): Promise<ArchiveClusterReport | undefined> => {
		const rows = await options.client.query<ArchiveFactRow>(CLUSTER_FACTS_SQL, [`{${clusterIds.join(",")}}`]);
		if (rows.length < 2) return undefined;
		const combined = (
			await combine(
				rows.map((row) => ({
					id: row.id,
					repository: row.repository ?? undefined,
					at: instantOf(row.occurred_at),
					body: row.body,
				})),
				options.signal,
			)
		)?.trim();
		if (!combined || combined.length < 24) {
			throw new Error("combiner returned empty or too-short body");
		}
		const canonical = rows[rows.length - 1]!;
		const supersededIds = rows.slice(0, -1).map((row) => row.id);
		const inputChars = rows.reduce((sum, row) => sum + row.body.length, 0);

		if (!dryRun) {
			const vector = await embed(combined, options.signal);
			if (!vector || vector.length === 0) {
				throw new Error("embedder returned no vector for consolidated fact");
			}
			const vectorLiteral = `[${vector.join(",")}]`;
			await options.client.query(UPDATE_CANONICAL_FACT_SQL, [
				canonical.id,
				combined,
				vectorLiteral,
				instantOf(canonical.occurred_at),
				canonical.source ?? "coding-agent-learn",
			]);
			await options.client.query(DELETE_SUPERSEDED_FACTS_SQL, [`{${supersededIds.join(",")}}`]);
		}

		return {
			canonicalId: canonical.id,
			supersededIds,
			inputCount: rows.length,
			inputChars,
			outputChars: combined.length,
			combinedBody: combined,
		};
	};

	for (let offset = 0; offset < targetClusters.length; offset += concurrency) {
		const batch = targetClusters.slice(offset, offset + concurrency);
		const outcomes = await Promise.allSettled(batch.map((clusterIds) => processOneCluster(clusterIds)));
		for (const outcome of outcomes) {
			if (outcome.status === "fulfilled") {
				if (outcome.value) {
					report.clustersConsolidated += 1;
					report.factsMerged += outcome.value.inputCount;
					report.factsRemoved += outcome.value.supersededIds.length;
					report.inputCharsTotal += outcome.value.inputChars;
					report.outputCharsTotal += outcome.value.outputChars;
					report.clusters.push(outcome.value);
				}
			} else {
				report.failed += 1;
				logger.debug("archive: cluster consolidation failed", { error: String(outcome.reason) });
			}
		}
	}

	return report;
}

const defaultStampPath = (): string => join(homedir(), ".omp", "agent", "archive-consolidated-at");

/**
 * Checks whether at least `intervalMs` (default 24h) has elapsed since the last consolidation stamp.
 * When due, writes the stamp immediately and starts `archiveConsolidateFacts` in the background.
 */
export function maybeScheduleDailyConsolidation(
	client: ArchiveClient,
	options: {
		stampPath?: string;
		intervalMs?: number;
		now?: () => number;
		run?: () => Promise<unknown>;
	} = {},
): boolean {
	const stampPath = options.stampPath ?? defaultStampPath();
	const intervalMs = options.intervalMs ?? ARCHIVE_CONSOLIDATE_INTERVAL_MS;
	const nowMs = options.now ? options.now() : Date.now();
	try {
		const raw = readFileSync(stampPath, "utf8").trim();
		const lastMs = Number(raw);
		if (Number.isFinite(lastMs) && nowMs - lastMs < intervalMs) {
			return false;
		}
	} catch {
		// Missing stamp file means consolidation is due.
	}
	try {
		mkdirSync(dirname(stampPath), { recursive: true });
		writeFileSync(stampPath, `${nowMs}\n`, "utf8");
	} catch {
		return false;
	}
	const task = options.run ?? (() => archiveConsolidateFacts({ client }));
	void task().catch((error) => {
		logger.debug("archive: daily consolidation failed", { error: String(error) });
	});
	return true;
}
