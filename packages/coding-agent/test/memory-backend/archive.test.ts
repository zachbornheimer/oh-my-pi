import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/config/settings";
import { archiveRepositoryOf, createArchiveBackend } from "../../src/memory-backend/archive/backend";
import {
	archiveBackfill,
	archiveBackfillSkipOf,
	archiveParseTranscript,
} from "../../src/memory-backend/archive/backfill";
import { openArchiveClient, type ArchiveClient } from "../../src/memory-backend/archive/client";
import {
	archiveClusterFacts,
	archiveConsolidateFacts,
	archiveMissingIdentifiersOf,
	archivePartitionByCharBudget,
	maybeScheduleDailyConsolidation,
} from "../../src/memory-backend/archive/consolidate";
import {
	ARCHIVE_EMBEDDING_DIMENSION,
	openArchiveEmbedder,
	openArchiveHaikuCombiner,
	openArchiveJevJudge,
} from "../../src/memory-backend/archive/openrouter";
import {
	ARCHIVE_RETAIN_CHUNK_CHARS,
	ArchiveRetainer,
	archiveChunkId,
	archiveChunksOf,
	archiveFactId,
	archiveScopeOf,
	archiveWriteFact,
	type ArchiveRetainerOptions,
} from "../../src/memory-backend/archive/retain";
import {
	archiveContextBlock,
	archiveContextBoost,
	archiveFuse,
	archiveRecall,
	archiveTermsOf,
	type ArchiveHit,
} from "../../src/memory-backend/archive/search";

const hit = (over: Partial<ArchiveHit> = {}): ArchiveHit => ({
	id: over.id ?? "id-1",
	repository: over.repository,
	kind: over.kind,
	at: over.at ?? "2026-11-05T00:00:00.000Z",
	score: over.score ?? 0,
	body: over.body ?? "a body",
	...(over.source === undefined ? {} : { source: over.source }),
});

describe("archiveRepositoryOf", () => {
	it("labels a checkout by its directory, lowercased", () => {
		expect(archiveRepositoryOf("/Users/x/Developer/Personal/Oh-My-Pi")).toBe("oh-my-pi");
	});
	it("labels a worktree by the branch directory, not the main checkout", () => {
		expect(
			archiveRepositoryOf("/Users/x/Developer/Personal/.worktrees/oh-my-pi-feat-archive-memory-backend"),
		).toBe("oh-my-pi-feat-archive-memory-backend");
	});
	it("returns undefined for an empty path", () => {
		expect(archiveRepositoryOf("")).toBeUndefined();
	});
});

describe("archiveTermsOf", () => {
	it("ORs lexemes so a question still matches", () => {
		expect(archiveTermsOf("why did the hook fail?")).toBe("'why' | 'did' | 'the' | 'hook' | 'fail'");
	});
	it("keeps both a compound token (_/-/. separated) and its component words", () => {
		expect(archiveTermsOf("tool_search CAPTURE_BROKEN linear.app/zysys/issue/ZYS-9082")).toBe(
			"'tool_search' | 'tool' | 'search' | 'capture_broken' | 'capture' | 'broken' | 'linear.app' | 'linear' | 'app' | 'zysys' | 'issue' | 'zys-9082' | 'zys' | '9082'",
		);
	});
	it("keeps a bare number and drops one-character words", () => {
		expect(archiveTermsOf("pid 9 a")).toBe("'pid' | '9'");
	});
	it("escapes a quote instead of breaking the query", () => {
		expect(archiveTermsOf("it's")).toBe("'it''s'");
	});
	it("deduplicates a repeated term", () => {
		expect(archiveTermsOf("cache cache")).toBe("'cache'");
	});
});

describe("archiveFuse", () => {
	it("scores agreement between arms above one arm's top hit", () => {
		const fused = archiveFuse([["a", "b"], ["b", "c"]]);
		expect(fused.get("b")).toBeGreaterThan(fused.get("a") ?? 0);
		expect(fused.get("b")).toBeGreaterThan(fused.get("c") ?? 0);
	});
});

describe("archiveContextBoost", () => {
	it("never excludes a row from another repository", () => {
		const other = hit({ repository: "zyins" });
		expect(archiveContextBoost(other, { repository: "webmaster" })).toBeGreaterThan(0);
	});
	it("ranks the working repository above a stranger", () => {
		const own = archiveContextBoost(hit({ repository: "webmaster" }), { repository: "webmaster" });
		const stranger = archiveContextBoost(hit({ repository: "zyins" }), { repository: "webmaster" });
		expect(own).toBeGreaterThan(stranger);
	});
	it("ranks a row naming a touched file above one that does not", () => {
		const named = archiveContextBoost(hit({ body: "edited src/memory/backend.ts today" }), {
			files: ["src/memory/backend.ts"],
		});
		const plain = archiveContextBoost(hit({ body: "edited nothing relevant" }), {
			files: ["src/memory/backend.ts"],
		});
		expect(named).toBeGreaterThan(plain);
	});
	it("matches a touched file by its last two segments", () => {
		expect(archiveContextBoost(hit({ body: "see memory/backend.ts" }), { files: ["src/memory/backend.ts"] })).toBeGreaterThan(1);
	});
	it("is 1 with no context", () => {
		expect(archiveContextBoost(hit(), {})).toBe(1);
	});
});

describe("archiveContextBlock", () => {
	it("returns undefined for no hit", () => {
		expect(archiveContextBlock([])).toBeUndefined();
	});
	it("renders <memories><memory relevance=...> tags and stays inside the budget", () => {
		const block = archiveContextBlock(
			[
				{ ...hit({ repository: "zyins", kind: "fact", body: "the fix was x", score: 0.84256 }), confidence: 0.84256 },
				{ ...hit({ id: "id-2", repository: "webmaster", kind: "chunk", body: "y", score: 0.71 }), confidence: 0.71 },
			],
			500,
		);
		expect(block).toContain('<memory relevance="0.84256">the fix was x</memory>');
		expect(block).toContain('<memory relevance="0.71">y</memory>');
		expect(block).toStartWith("<memories>\n");
		expect(block).toEndWith("\n</memories>");
		expect(block!.length).toBeLessThanOrEqual(500 + 200);
	});
	it("drops an entry that would not fit rather than cutting it", () => {
		const long = "z".repeat(400);
		const block = archiveContextBlock([hit({ body: long }), hit({ id: "b", body: long })], 420);
		expect(block).toContain("z");
		const entries = block!.split("\n").filter((line: string) => line.startsWith("<memory ")).length;
		expect(entries).toBe(1);
	});
});

describe("openArchiveClient", () => {
	it("answers empty and never throws without a connection string", async () => {
		const client = openArchiveClient({ env: {}, readFile: () => undefined });
		expect(client.url).toBeUndefined();
		expect(await client.query("select 1")).toEqual([]);
	});
	it("binds values and returns the driver's rows", async () => {
		const seen: { text: string; values?: readonly unknown[] }[] = [];
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>(text: string, values?: readonly unknown[]) => {
					seen.push({ text, values });
					return [{ n: 1 }] as T[];
				},
			}),
		});
		expect(await client.query("select $1::int as n", [1])).toEqual([{ n: 1 }]);
		expect(seen[0]?.values).toEqual([1]);
	});
	it("opens the default driver with a bounded pool", async () => {
		const bun = Bun as unknown as { SQL: unknown };
		const realSql = bun.SQL;
		const constructed: { url: string; options: unknown }[] = [];
		bun.SQL = class {
			constructor(url: string, options: unknown) {
				constructed.push({ url, options });
			}
			async unsafe() {
				return [];
			}
		};
		try {
			const client = openArchiveClient({ env: { SESSIONS_DB_URL: "postgres://stub/db" } });
			await client.query("select 1");
			await client.query("select 2");
		} finally {
			bun.SQL = realSql;
		}
		expect(constructed).toEqual([
			{ url: "postgres://stub/db", options: { max: 2, idleTimeout: 5, connectionTimeout: 15 } },
		]);
	});
});

describe("archiveRecall", () => {
	it("reports an empty query without touching the store", async () => {
		let called = false;
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async () => {
					called = true;
					return [];
				},
			}),
		});
		const result = await archiveRecall(client, "   ", {});
		expect(result.hits).toEqual([]);
		expect(called).toBe(false);
	});
	it("never throws when the store refuses; the arm reports why", async () => {
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async () => {
					throw new Error("relation does not exist");
				},
			}),
		});
		const result = await archiveRecall(client, "memory backend", { repository: "oh-my-pi" });
		expect(result.hits).toEqual([]);
		expect(result.lexical.used).toBe(false);
		expect(result.lexical.reason).toContain("does not exist");
	});
	it("fuses facts and chunks as separate arms so a batch of facts cannot starve a matching chunk", async () => {
		const facts = Array.from({ length: 20 }, (_, index) => ({
			id: `fact-${index}`,
			session_path: null,
			source: "learn",
			repository: "other",
			scope: "personal",
			kind: "fact",
			occurred_at: "2026-11-01T00:00:00.000Z",
			body: `fact ${index} about the gateway`,
			rank: 0.9 - index * 0.01,
		}));
		const chunk = {
			id: "chunk-0",
			session_path: "/s/0.jsonl",
			source: "omp",
			repository: "oh-my-pi",
			scope: "personal",
			kind: "chunk",
			occurred_at: "2026-11-10T00:00:00.000Z",
			body: "[role: assistant]\nthe gateway lives in src/gateway/port-4600.ts",
			rank: 0.23,
		};
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>() => [...facts, chunk] as unknown as T[],
			}),
		});
		const result = await archiveRecall(
			client,
			"gateway port 4600",
			{ repository: "oh-my-pi", files: ["src/gateway/port-4600.ts"] },
			{ limit: 5 },
		);
		expect(result.hits[0]?.id).toBe("chunk-0");
	});
	it("keeps all memories clearing the Jev relevance threshold (not capped at 5) and returns 0 when none clear it", async () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `fact-${index}`,
			session_path: null,
			source: "learn",
			repository: "oh-my-pi",
			scope: "personal",
			kind: "fact",
			occurred_at: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
			body: `relevant fact ${index}`,
			rank: 0.9 - index * 0.01,
		}));
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>() => rows as unknown as T[],
			}),
		});

		const eightRelevant = await archiveRecall(
			client,
			"relevant fact",
			{ repository: "oh-my-pi" },
			{
				threshold: 0.65,
				judge: async (_query, candidates) =>
					new Map(candidates.map((c, idx) => [c.id, idx < 8 ? 0.95 - idx * 0.02 : 0.2])),
			},
		);
		expect(eightRelevant.hits).toHaveLength(8);
		expect(eightRelevant.hits[0]?.confidence).toBe(0.95);
		expect(eightRelevant.judge).toMatchObject({ used: true, kept: 8, threshold: 0.65 });

		const noneRelevant = await archiveRecall(
			client,
			"reverse a linked list",
			{ repository: "oh-my-pi" },
			{
				threshold: 0.65,
				judge: async (_query, candidates) => new Map(candidates.map((c) => [c.id, 0.12])),
			},
		);
		expect(noneRelevant.hits).toEqual([]);
		expect(noneRelevant.judge).toMatchObject({ used: true, kept: 0, threshold: 0.65 });
	});
});

describe("openArchiveEmbedder, openArchiveJevJudge, and openArchiveHaikuCombiner", () => {
	it("calls OpenRouter embeddings, Jev systemone, and Haiku chat endpoints and parses responses", async () => {
		const embed = openArchiveEmbedder({
			apiKey: "test-key",
			fetch: (async () =>
				new Response(
					JSON.stringify({
						data: [{ index: 0, embedding: Array.from({ length: ARCHIVE_EMBEDDING_DIMENSION }, () => 0.125) }],
					}),
					{ status: 200 },
				)) as unknown as typeof fetch,
		});
		const vector = await embed("test query");
		expect(vector).toHaveLength(ARCHIVE_EMBEDDING_DIMENSION);

		const judge = openArchiveJevJudge({
			apiKey: "test-key",
			fetch: (async () =>
				new Response(
					JSON.stringify({
						answers: {
							m_0: { type: "noul", noul: 0.91 },
							m_1: { type: "noul", noul: 0.14 },
						},
					}),
					{ status: 200 },
				)) as unknown as typeof fetch,
		});
		const scores = await judge("test query", [hit({ id: "a", body: "match" }), hit({ id: "b", body: "miss" })]);
		expect(scores.get("a")).toBe(0.91);
		expect(scores.get("b")).toBe(0.14);

		const combine = openArchiveHaikuCombiner({
			apiKey: "test-key",
			fetch: (async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "[context: merged]\nCombined fact preserving id-1 and id-2." } }],
					}),
					{ status: 200 },
				)) as unknown as typeof fetch,
		});
		const merged = await combine([
			{ id: "id-1", repository: "oh-my-pi", at: "2026-11-10T00:00:00.000Z", body: "fact 1" },
			{ id: "id-2", repository: "oh-my-pi", at: "2026-11-11T00:00:00.000Z", body: "fact 2" },
		]);
		expect(merged).toContain("Combined fact preserving id-1 and id-2.");
	});
});

describe("archiveClusterFacts and archiveConsolidateFacts", () => {
	it("groups connected similarity components and merges each cluster into its newest row", async () => {
		const clusters = archiveClusterFacts([
			{ id1: "f1", id2: "f2", similarity: 0.92 },
			{ id1: "f2", id2: "f3", similarity: 0.89 },
			{ id1: "g1", id2: "g2", similarity: 0.91 },
		]);
		expect(clusters).toEqual([
			["f1", "f2", "f3"],
			["g1", "g2"],
		]);

		const executed: { text: string; values: readonly unknown[] }[] = [];
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>(text: string, values: readonly unknown[] = []) => {
					executed.push({ text, values });
					if (text.includes("select id, embedding::text as embedding")) {
						return [
							{ id: "f1", embedding: "[1,0]" },
							{ id: "f2", embedding: "[0.98,0.198]" },
							{ id: "f3", embedding: "[0.96,0.28]" },
							{ id: "other", embedding: "[0,1]" },
						] as unknown as T[];
					}
					if (text.includes("where kind = 'fact' and embedding is null")) {
						return [{ id: "unembedded-1", body: "unembedded fact" }] as unknown as T[];
					}
					if (text.includes("where kind = 'fact' and id = any")) {
						return [
							{
								id: "f1",
								source: "coding-agent-learn",
								session_path: "/s/1.jsonl",
								repository: "agent",
								scope: "personal",
								occurred_at: "2026-11-11T10:00:00.000Z",
								body: "early fact with i-06e7c0292483e95d6",
							},
							{
								id: "f2",
								source: "coding-agent-learn",
								session_path: "/s/1.jsonl",
								repository: "agent",
								scope: "personal",
								occurred_at: "2026-11-11T11:00:00.000Z",
								body: "middle fact with 100.92.190.20",
							},
							{
								id: "f3",
								source: "coding-agent-learn",
								session_path: "/s/1.jsonl",
								repository: "agent",
								scope: "personal",
								occurred_at: "2026-11-11T12:00:00.000Z",
								body: "newest fact with sg-02761bac2b11499cd",
							},
						] as unknown as T[];
					}
					return [] as unknown as T[];
				},
			}),
		});

		const report = await archiveConsolidateFacts({
			client,
			combine: async (facts) => `[context: merged]\n${facts.map((f) => f.body).join(" + ")}`,
			embed: async () => [0.25, 0.75],
		});
		expect(report).toMatchObject({
			clustersFound: 1,
			clustersConsolidated: 1,
			factsMerged: 3,
			factsRemoved: 2,
			failed: 0,
		});
		expect(report.clusters[0]?.canonicalId).toBe("f3");
		expect(report.clusters[0]?.supersededIds).toEqual(["f1", "f2"]);
		const embedBackfillCall = executed.find((call) =>
			call.text.includes("where id = $1 and kind = 'fact' and embedding is null"),
		);
		expect(embedBackfillCall?.values).toEqual(["unembedded-1", "[0.25,0.75]"]);
		const updateCall = executed.find((call) => call.text.includes("set body = $2"));
		const deleteCall = executed.find((call) => call.text.startsWith("delete from public.memory_chunks"));
		expect(updateCall?.values[0]).toBe("f3");
		expect(String(updateCall?.values[1])).toContain("i-06e7c0292483e95d6");
		expect(String(updateCall?.values[1])).toContain("100.92.190.20");
		expect(deleteCall?.values[0]).toBe("{f1,f2}");
	});
	it("partitions clusters by character budget and refuses merges that drop concrete identifiers", async () => {
		const partitioned = archivePartitionByCharBudget(
			[
				{ id: "r1", source: "omp", session_path: "/s", repository: "r", scope: "personal", occurred_at: "2026-11-11T01:00:00Z", body: "a".repeat(3000) },
				{ id: "r2", source: "omp", session_path: "/s", repository: "r", scope: "personal", occurred_at: "2026-11-11T02:00:00Z", body: "b".repeat(3000) },
				{ id: "r3", source: "omp", session_path: "/s", repository: "r", scope: "personal", occurred_at: "2026-11-11T03:00:00Z", body: "c".repeat(3000) },
				{ id: "r4", source: "omp", session_path: "/s", repository: "r", scope: "personal", occurred_at: "2026-11-11T04:00:00Z", body: "d".repeat(3000) },
				{ id: "huge", source: "omp", session_path: "/s", repository: "r", scope: "personal", occurred_at: "2026-11-11T05:00:00Z", body: "x".repeat(9000) },
			],
			7000,
		);
		expect(partitioned.map((batch) => batch.map((r) => r.id))).toEqual([
			["r1", "r2"],
			["r3", "r4"],
		]);

		expect(
			archiveMissingIdentifiersOf(
				["Host 100.92.190.20 on i-06e7c0292483e95d6 edits `~/.omp/agent/config.yml`"],
				"Host 100.92.190.20 edits `~/.omp/agent/config.yml`",
			),
		).toEqual(["i-06e7c0292483e95d6"]);

		const executed: string[] = [];
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>(text: string) => {
					executed.push(text);
					if (text.includes("select id, embedding::text as embedding")) {
						return [
							{ id: "f1", embedding: "[1,0]" },
							{ id: "f2", embedding: "[0.99,0.1]" },
						] as unknown as T[];
					}
					if (text.includes("where kind = 'fact' and id = any")) {
						return [
							{
								id: "f1",
								source: "coding-agent-learn",
								session_path: "/s/1.jsonl",
								repository: "agent",
								scope: "personal",
								occurred_at: "2026-11-11T10:00:00.000Z",
								body: "early fact with i-06e7c0292483e95d6 and 100.92.190.20",
							},
							{
								id: "f2",
								source: "coding-agent-learn",
								session_path: "/s/1.jsonl",
								repository: "agent",
								scope: "personal",
								occurred_at: "2026-11-11T11:00:00.000Z",
								body: "later fact with sg-02761bac2b11499cd",
							},
						] as unknown as T[];
					}
					return [] as unknown as T[];
				},
			}),
		});

		const report = await archiveConsolidateFacts({
			client,
			combine: async () => "[context: dropped ip]\nCombined fact with i-06e7c0292483e95d6 and sg-02761bac2b11499cd only",
			embed: async () => [0.5, 0.5],
		});
		expect(report).toMatchObject({
			clustersFound: 1,
			clustersConsolidated: 0,
			clustersRefusedMissingIdentifiers: 1,
			factsRemoved: 0,
		});
		expect(executed.some((sql) => sql.startsWith("delete from public.memory_chunks"))).toBe(false);
	});

	it("schedules daily consolidation at most once per 24h interval", async () => {
		const dir = mkdtempSync(join(tmpdir(), "archive-consolidate-"));
		try {
			const stampPath = join(dir, "stamp");
			let runs = 0;
			const client = openArchiveClient({ env: {}, readFile: () => undefined });
			const first = maybeScheduleDailyConsolidation(client, {
				stampPath,
				now: () => 1_000_000,
				run: async () => {
					runs += 1;
				},
			});
			const second = maybeScheduleDailyConsolidation(client, {
				stampPath,
				now: () => 1_000_000 + 3600_000,
				run: async () => {
					runs += 1;
				},
			});
			const afterDay = maybeScheduleDailyConsolidation(client, {
				stampPath,
				now: () => 1_000_000 + 25 * 3600_000,
				run: async () => {
					runs += 1;
				},
			});
			expect(first).toBe(true);
			expect(second).toBe(false);
			expect(afterDay).toBe(true);
			expect(runs).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("archiveScopeOf", () => {
	const home = "/Users/x";
	it("maps the two org directories and everything else", () => {
		expect(archiveScopeOf("/Users/x/Developer/Software-Automation-Holdings/api", home)).toBe("sah");
		expect(archiveScopeOf("/Users/x/Developer/Zysys/site", home)).toBe("zysys");
		expect(archiveScopeOf("/Users/x/Developer/Personal/oh-my-pi", home)).toBe("personal");
		expect(archiveScopeOf("/Users/x/Developer/Personal/.worktrees/zysys", home)).toBe("personal");
		expect(archiveScopeOf("/tmp/scratch", home)).toBe("personal");
	});
});

describe("archiveChunksOf", () => {
	it("keeps every chunk within the ceiling, indexes from 0, and is a pure function of its input", () => {
		const long = Array.from({ length: 900 }, (_, i) => `line ${i} of a long answer`).join("\n");
		const messages = [
			{ role: "user", content: "short question", timestamp: "2026-11-09T10:00:00.000Z" },
			{ role: "assistant", content: long, timestamp: "2026-11-09T10:00:05.000Z" },
		];
		const chunks = archiveChunksOf(messages);
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
		for (const chunk of chunks) expect(chunk.body.length).toBeLessThanOrEqual(ARCHIVE_RETAIN_CHUNK_CHARS);
		expect(chunks[0]?.body).toBe("[role: user]\nshort question");
		expect(archiveChunksOf(messages)).toEqual(chunks);
	});
	it("redacts a secret before it can be split across chunks", () => {
		const provider = "ghp";
		const leaked = `${provider}_${"a1".repeat(18)}`;
		const chunks = archiveChunksOf([{ role: "user", content: `${"word ".repeat(900)}${leaked} tail` }]);
		expect(chunks.length).toBeGreaterThan(1);
		const stored = chunks.map((chunk) => chunk.body).join("");
		expect(stored).toContain("[REDACTED]");
		expect(stored).not.toContain("a1a1a1a1a1");
	});
	it("derives the same id for the same path and index, and a different one otherwise", () => {
		expect(archiveChunkId("/s/a.jsonl", 3)).toBe(archiveChunkId("/s/a.jsonl", 3));
		expect(archiveChunkId("/s/a.jsonl", 3)).not.toBe(archiveChunkId("/s/a.jsonl", 4));
		expect(archiveChunkId("/s/a.jsonl", 3)).not.toBe(archiveChunkId("/s/b.jsonl", 3));
		expect(archiveChunkId("/s/a.jsonl", 3)).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
	});
	it("strips runtime-injected <system-context> and <memories> blocks before chunking", () => {
		const messages = [
			{
				role: "user",
				content: [
					"How do we fix ZYS-9082?",
					"",
					'<system-context source="extension/onUserPromptSubmit" origin="runtime">',
					"<memories>",
					'<memory relevance="0.93063">Old recalled memory that must not be re-retained</memory>',
					"</memories>",
					"</system-context>",
				].join("\n"),
			},
		];
		const chunks = archiveChunksOf(messages);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.body).toBe("[role: user]\nHow do we fix ZYS-9082?");
		expect(chunks[0]?.body).not.toContain("<memories>");
		expect(chunks[0]?.body).not.toContain("<system-context");
	});
});

type Statement = { text: string; values: readonly unknown[] };
type StoredChunk = { id: string; session_path: string; chunk_index: number; occurred_at: string };

interface FakeArchiveStore {
	client: ArchiveClient;
	stored: StoredChunk[];
	inserts: Statement[];
	failure: { error?: Error; contentOf?: string };
	files: Map<string, { content: string; mtime: number }>;
}

const archiveFake = (
	init: { files?: Record<string, { content: string; mtime: number }>; chunks?: StoredChunk[] } = {},
): FakeArchiveStore => {
	const files = new Map(Object.entries(init.files ?? {}));
	const stored: StoredChunk[] = [...(init.chunks ?? [])];
	const inserts: Statement[] = [];
	const failure: { error?: Error; contentOf?: string } = {};
	const lastAt = (path: string) =>
		Math.max(-1, ...stored.filter((chunk) => chunk.session_path === path).map((chunk) => Date.parse(chunk.occurred_at)));
	const client = openArchiveClient({
		env: { SESSIONS_DB_URL: "postgres://stub/db" },
		connect: () => ({
			unsafe: async <T>(text: string, values: readonly unknown[] = []) => {
				if (failure.error) throw failure.error;
				if (text.includes("from public.omp_session_files f")) {
					const since = Number(values[0]);
					return [...files.entries()]
						.filter(([path, file]) => file.mtime >= since && (lastAt(path) < 0 || file.mtime > lastAt(path)))
						.sort((a, b) => b[1].mtime - a[1].mtime)
						.map(([path, file]) => ({ path, mtime_ms: String(file.mtime) })) as T[];
				}
				if (text.includes("select content from public.omp_session_files")) {
					if (failure.contentOf === values[0]) throw new Error("content refused");
					const file = files.get(String(values[0]));
					return (file === undefined ? [] : [{ content: file.content }]) as T[];
				}
				if (text.includes("select chunk_index, occurred_at, id")) {
					const rows = stored
						.filter((chunk) => chunk.session_path === values[0])
						.sort((a, b) => a.chunk_index - b.chunk_index);
					const first = rows.find((chunk) => chunk.chunk_index === 0);
					const last = rows[rows.length - 1];
					return [...new Set([first, last])].filter((chunk) => chunk !== undefined) as T[];
				}
				if (text.includes("insert into public.memory_chunks")) {
					inserts.push({ text, values });
					const [id, , sessionPath, , , occurredAt, chunkIndex] = values as [string, string, string, unknown, unknown, string, number];
					if (stored.some((chunk) => chunk.id === id)) return [] as T[];
					stored.push({ id, session_path: sessionPath, chunk_index: chunkIndex, occurred_at: occurredAt });
					return [{ id }] as T[];
				}
				throw new Error(`unexpected statement: ${text}`);
			},
		}),
	});
	return { client, stored, inserts, failure, files };
};

const legacyChunks = (path: string, times: string[]): StoredChunk[] =>
	times.map((at, index) => ({
		id: `${String(index).padStart(2, "0")}${"ab".repeat(15)}`,
		session_path: path,
		chunk_index: index,
		occurred_at: at,
	}));

const transcriptOf = (cwd: string | undefined, turns: [string, string, string][]): string =>
	`${[
		JSON.stringify({ type: "title", v: 1, title: "" }),
		JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-09T10:00:00.000Z", ...(cwd === undefined ? {} : { cwd }) }),
		...turns.flatMap(([role, text, at]) => [
			JSON.stringify({
				type: "message",
				id: at,
				timestamp: at,
				message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
			}),
			JSON.stringify({ type: "message", id: `${at}-tool`, timestamp: at, message: { role: "toolResult", content: [{ type: "text", text: "tool output nobody keeps" }] } }),
		]),
	].join("\n")}\n`;

interface FakeRetainerSession {
	entries: unknown[];
	session: ArchiveRetainerOptions["session"];
}

describe("ArchiveRetainer", () => {
	const SESSION_PATH = "/sessions/2026-11-09_abc.jsonl";

	const fakeSession = (entries: unknown[] = [], sessionFile: string | null = SESSION_PATH): FakeRetainerSession => ({
		entries,
		session: {
			subscribe: () => () => {},
			sessionManager: { getEntries: () => entries as never, getSessionFile: () => sessionFile ?? undefined },
		},
	});
	let clock = 0;
	const turn = (role: "user" | "assistant", text: string) => ({
		type: "message",
		timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, clock++)).toISOString(),
		message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
	});
	const six = () => [
		turn("user", "first question"),
		turn("assistant", "first answer"),
		turn("user", "second question"),
		turn("assistant", "second answer"),
		turn("user", "third question"),
		turn("assistant", "third answer"),
	];
	const retainer = (
		store: FakeArchiveStore,
		session: FakeRetainerSession,
		over: Partial<ArchiveRetainerOptions> = {},
	) =>
		new ArchiveRetainer({
			client: store.client,
			session: session.session,
			repository: "oh-my-pi",
			scope: "personal",
			enabled: () => true,
			everyNTurns: () => 2,
			...over,
		});

	it("writes nothing while the unretained user turns are under the threshold", async () => {
		const store = archiveFake();
		const session = fakeSession([turn("user", "first question"), turn("assistant", "first answer")]);
		expect(await retainer(store, session).retain()).toBe(0);
		expect(store.inserts).toEqual([]);
	});

	it("writes one bound-parameter row per chunk once the threshold is crossed", async () => {
		const store = archiveFake();
		const session = fakeSession(six().slice(0, 4));
		expect(await retainer(store, session).retain()).toBe(4);
		expect(store.inserts).toHaveLength(4);
		store.inserts.forEach((write, index) => {
			const [id, source, sessionPath, repository, scope, occurredAt, chunkIndex, body, embedding] = write.values;
			expect(write.text).toContain("on conflict (id) do nothing");
			expect(write.text).toContain("$8");
			expect(write.text).not.toContain("question");
			expect(id).toBe(archiveChunkId(SESSION_PATH, index));
			expect(source).toBe("omp");
			expect(sessionPath).toBe(SESSION_PATH);
			expect(repository).toBe("oh-my-pi");
			expect(scope).toBe("personal");
			expect(occurredAt).toBe((session.entries[index] as { timestamp: string }).timestamp);
			expect(chunkIndex).toBe(index);
			expect(embedding).toBeNull();
			expect(String(body)).toStartWith(index % 2 === 0 ? "[role: user]\n" : "[role: assistant]\n");
		});
	});

	it("does not write again for a transcript the store already holds, even from a fresh retainer", async () => {
		const store = archiveFake();
		const session = fakeSession(six().slice(0, 4));
		const subject = retainer(store, session);
		await subject.retain();
		expect(await subject.retain()).toBe(0);
		expect(await retainer(store, session).retain()).toBe(0);
		expect(store.inserts).toHaveLength(4);
	});

	it("writes only the chunks past what the store already holds for a resumed session", async () => {
		const entries = six();
		const store = archiveFake({
			chunks: [0, 1, 2, 3].map((index) => ({
				id: archiveChunkId(SESSION_PATH, index),
				session_path: SESSION_PATH,
				chunk_index: index,
				occurred_at: (entries[index] as { timestamp: string }).timestamp,
			})),
		});
		expect(await retainer(store, fakeSession(entries)).retain()).toBe(2);
		expect(store.inserts.map((write) => write.values[6])).toEqual([4, 5]);
	});

	it("continues a transcript earlier ingestion already cut, by turn time and without renumbering", async () => {
		const entries = six();
		const stamp = (index: number) => (entries[index] as { timestamp: string }).timestamp;
		const store = archiveFake({ chunks: legacyChunks(SESSION_PATH, [stamp(1), stamp(3)]) });
		expect(await retainer(store, fakeSession(entries)).retain()).toBe(2);
		expect(store.inserts.map((write) => write.values[6])).toEqual([2, 3]);
		expect(store.inserts.map((write) => String(write.values[7]))).toEqual([
			"[role: user]\nthird question",
			"[role: assistant]\nthird answer",
		]);
		expect(await retainer(store, fakeSession(entries)).retain()).toBe(0);
	});

	it("leaves embedding null when the embedder fails and stores the vector when it answers", async () => {
		const entries = [turn("user", "first question"), turn("assistant", "first answer")];
		const failing = archiveFake();
		await retainer(failing, fakeSession(entries), {
			everyNTurns: () => 1,
			embed: async () => {
				throw new Error("no model");
			},
		}).retain();
		expect(failing.inserts.map((write) => write.values[8])).toEqual([null, null]);
		const working = archiveFake();
		await retainer(working, fakeSession(entries), { everyNTurns: () => 1, embed: async () => [0.5, -1] }).retain();
		expect(working.inserts.map((write) => write.values[8])).toEqual(["[0.5,-1]", "[0.5,-1]"]);
	});

	it("writes nothing when retention is switched off or the session has no transcript file", async () => {
		const entries = [turn("user", "first question"), turn("user", "second question")];
		const off = archiveFake();
		expect(await retainer(off, fakeSession(entries), { enabled: () => false }).retain()).toBe(0);
		const unsaved = archiveFake();
		expect(await retainer(unsaved, fakeSession(entries, null)).retain()).toBe(0);
		expect(off.inserts).toEqual([]);
		expect(unsaved.inserts).toEqual([]);
	});

	it("swallows a store failure, and retries the same turns on the next call", async () => {
		const entries = [turn("user", "first question"), turn("assistant", "first answer"), turn("user", "second one")];
		const store = archiveFake();
		store.failure.error = new Error("connection refused");
		const subject = retainer(store, fakeSession(entries));
		expect(await subject.retain()).toBe(0);
		expect(store.inserts).toEqual([]);

		store.failure.error = undefined;
		expect(await subject.retain()).toBe(3);
		expect(store.inserts).toHaveLength(3);
	});
});

describe("archive backend retention wiring", () => {
	const SESSION_PATH = "/sessions/2026-11-09_wired.jsonl";
	const SETTLE_MS = 20;
	const entries = [
		{
			type: "message",
			timestamp: "2026-11-09T10:00:00.000Z",
			message: { role: "user", content: "how do I retain turns" },
		},
		{
			type: "message",
			timestamp: "2026-11-09T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "subscribe to agent_end" }] },
		},
	];

	/** Starts the backend on a fake session and ends one agent turn on it. */
	const settleTurn = async (overrides: Record<string, unknown>, taskDepth = 0) => {
		const store = archiveFake();
		const listeners: Array<(event: { type: string }) => void> = [];
		const session = {
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			sessionManager: {
				getCwd: () => "/Users/x/Developer/Personal/oh-my-pi",
				getEntries: () => entries,
				getSessionFile: () => SESSION_PATH,
			},
		};
		await createArchiveBackend({ client: store.client }).start({
			session: session as never,
			settings: Settings.isolated(overrides),
			modelRegistry: undefined as never,
			agentDir: "/agent",
			taskDepth,
		});
		for (const listener of listeners) listener({ type: "agent_end" });
		await Bun.sleep(SETTLE_MS);
		return store;
	};

	it("retains a settled turn when the archive backend is selected", async () => {
		const store = await settleTurn({ "memory.backend": "archive" });
		expect(store.inserts).toHaveLength(2);
		expect(store.inserts.every((write) => write.values[2] === SESSION_PATH)).toBe(true);
	});

	it("retains nothing when another backend is selected, when archive.autoRetain is off, or in a subagent", async () => {
		expect((await settleTurn({ "memory.backend": "mnemopi" })).inserts).toEqual([]);
		expect((await settleTurn({ "memory.backend": "archive", "archive.autoRetain": false })).inserts).toEqual([]);
		expect((await settleTurn({ "memory.backend": "archive" }, 1)).inserts).toEqual([]);
	});
});

describe("archiveBackfillSkipOf", () => {
	const sessions = "/Users/x/.omp/agent/sessions";
	it("keeps a project's own transcript", () => {
		expect(archiveBackfillSkipOf(`${sessions}/-Developer-Personal-oh-my-pi/2026-11-09T10-00-00-000Z_abc.jsonl`)).toBeUndefined();
	});
	it("names why each kind of noise is dropped", () => {
		const dir = `${sessions}/-Developer-Personal-oh-my-pi`;
		const parent = "2026-11-09T10-00-00-000Z_01a1c3a3-e7b9";
		expect(archiveBackfillSkipOf("/tmp/probe/s/2026-11-02T17-38-36-574Z_abc.jsonl")).toBe("scratch-directory");
		expect(archiveBackfillSkipOf(`${sessions}/-tmp/2026-11-09T10-00-00-000Z_abc.jsonl`)).toBe("scratch-directory");
		expect(archiveBackfillSkipOf(`${sessions}/--private-tmp--/2026-11-09T10-00-00-000Z_abc.jsonl`)).toBe("scratch-directory");
		expect(archiveBackfillSkipOf(`${sessions}/-empty/2026-11-09T10-00-00-000Z_abc.jsonl`)).toBe("scratch-directory");
		expect(archiveBackfillSkipOf(`${dir}/${parent}/__advisor.default.jsonl`)).toBe("advisor");
		expect(archiveBackfillSkipOf(`${dir}/${parent}/ScopeRepair.jsonl`)).toBe("subagent");
		expect(archiveBackfillSkipOf(`${dir}/${parent}/UnitJ-2/UnitJ-2.UnitJ-Flow.jsonl`)).toBe("subagent");
		expect(archiveBackfillSkipOf("__sync__/dev-profile-reconciled.bundle.b64")).toBe("not-transcript");
	});
});

describe("archiveParseTranscript", () => {
	it("reads the cwd and only user and assistant text, in the shape extractMessages yields", () => {
		const content = transcriptOf("/Users/x/Developer/Personal/oh-my-pi", [
			["user", "where is the cursor", "2026-11-09T10:00:00.000Z"],
			["assistant", "in retain.ts", "2026-11-09T10:00:05.000Z"],
		]);
		const parsed = archiveParseTranscript(`${content}{"type":"message","timestamp":"2026-11-09T10:00:06.000Z","mes`);
		expect(parsed.cwd).toBe("/Users/x/Developer/Personal/oh-my-pi");
		expect(parsed.messages).toEqual([
			{ role: "user", content: "where is the cursor", timestamp: "2026-11-09T10:00:00.000Z" },
			{ role: "assistant", content: "in retain.ts", timestamp: "2026-11-09T10:00:05.000Z" },
		]);
	});
});

describe("archiveBackfill", () => {
	const HOME = "/Users/x";
	const dir = "/Users/x/.omp/agent/sessions/-Developer-Personal-oh-my-pi";
	const PATH = `${dir}/2026-11-09T10-00-00-000Z_abc.jsonl`;
	const four: [string, string, string][] = [
		["user", "first question", "2026-11-09T10:00:00.000Z"],
		["assistant", "first answer", "2026-11-09T10:00:05.000Z"],
		["user", "second question", "2026-11-09T10:01:00.000Z"],
		["assistant", "second answer", "2026-11-09T10:01:05.000Z"],
	];
	const MTIME = Date.parse("2026-11-09T10:02:00.000Z");
	const file = (turns: [string, string, string][], cwd: string | undefined = `${HOME}/Developer/Personal/oh-my-pi`) => ({
		content: transcriptOf(cwd, turns),
		mtime: MTIME,
	});
	const nativeChunks = (path: string, times: string[]): StoredChunk[] =>
		times.map((at, index) => ({ id: archiveChunkId(path, index), session_path: path, chunk_index: index, occurred_at: at }));

	it("writes nothing for a transcript that is already fully chunked", async () => {
		const store = archiveFake({
			files: { [PATH]: file(four) },
			chunks: nativeChunks(PATH, four.map(([, , at]) => at)),
		});
		const report = await archiveBackfill({ client: store.client, home: HOME });
		expect(store.inserts).toEqual([]);
		expect(report).toMatchObject({ considered: 1, upToDate: 1, chunks: 0, sessionsWritten: 0, failed: 0 });
	});

	it("writes only the new turns, continuing chunk_index, with repository and scope from the transcript", async () => {
		const cwd = `${HOME}/Developer/Software-Automation-Holdings/zyins-api`;
		const store = archiveFake({
			files: { [PATH]: file(four, cwd) },
			chunks: nativeChunks(PATH, four.slice(0, 2).map(([, , at]) => at)),
		});
		const report = await archiveBackfill({ client: store.client, home: HOME });
		expect(report).toMatchObject({ considered: 1, chunks: 2, sessionsWritten: 1, failed: 0 });
		expect(store.inserts.map((write) => write.values[6])).toEqual([2, 3]);
		for (const write of store.inserts) {
			expect(write.text).toContain("$8");
			expect(write.values[2]).toBe(PATH);
			expect(write.values[3]).toBe("zyins-api");
			expect(write.values[4]).toBe("sah");
			expect(write.values[8]).toBeNull();
		}
		expect(store.inserts.map((write) => write.values[0])).toEqual([archiveChunkId(PATH, 2), archiveChunkId(PATH, 3)]);
		expect(store.inserts.map((write) => String(write.values[7]))).toEqual([
			"[role: user]\nsecond question",
			"[role: assistant]\nsecond answer",
		]);
	});

	it("continues a transcript earlier ingestion cut differently, by turn time", async () => {
		const store = archiveFake({
			files: { [PATH]: file(four) },
			chunks: legacyChunks(PATH, ["2026-11-09T10:00:05.000Z"]),
		});
		await archiveBackfill({ client: store.client, home: HOME });
		expect(store.inserts.map((write) => write.values[6])).toEqual([1, 2]);
		expect(store.inserts.map((write) => String(write.values[7]).split("\n")[1])).toEqual([
			"second question",
			"second answer",
		]);
	});

	it("skips scratch, advisor and subagent transcripts and still writes the project's own", async () => {
		const parent = "2026-11-09T09-00-00-000Z_01a1c3a3-e7b9";
		const sessions = "/Users/x/.omp/agent/sessions";
		const files = Object.fromEntries(
			[
				PATH,
				`${sessions}/-tmp/2026-11-09T10-00-00-000Z_abc.jsonl`,
				`${sessions}/-empty/2026-11-09T10-00-00-000Z_abc.jsonl`,
				"/tmp/probe/s/2026-11-02T17-38-36-574Z_abc.jsonl",
				`${dir}/${parent}/__advisor.default.jsonl`,
				`${dir}/${parent}/ScopeRepair.jsonl`,
				"__sync__/dev-profile-reconciled.bundle.b64",
			].map((path) => [path, file(four)]),
		);
		const store = archiveFake({ files });
		const scratchCwd = `${sessions}/-Developer-Personal-other/2026-11-09T11-00-00-000Z_def.jsonl`;
		store.files.set(scratchCwd, file(four, "/private/tmp/scratch"));
		const report = await archiveBackfill({ client: store.client, home: HOME });
		expect(report.skipped).toEqual({ "scratch-directory": 3, advisor: 1, subagent: 1, "not-transcript": 1, "scratch-cwd": 1 });
		expect(report).toMatchObject({ listed: 8, considered: 1, sessionsWritten: 1, chunks: 4 });
		expect(new Set(store.inserts.map((write) => write.values[2]))).toEqual(new Set([PATH]));
	});

	it("reports what it would write on a dry run and writes nothing, then writes nothing new on a rerun", async () => {
		const store = archiveFake({ files: { [PATH]: file(four) } });
		const dry = await archiveBackfill({ client: store.client, home: HOME, dryRun: true });
		expect(dry).toMatchObject({ dryRun: true, considered: 1, sessionsWritten: 1, chunks: 4 });
		expect(store.inserts).toEqual([]);
		expect(store.stored).toEqual([]);

		const first = await archiveBackfill({ client: store.client, home: HOME });
		expect(first).toMatchObject({ dryRun: false, chunks: 4 });
		expect(store.stored).toHaveLength(4);
		const again = await archiveBackfill({ client: store.client, home: HOME });
		expect(again).toMatchObject({ upToDate: 1, chunks: 0, sessionsWritten: 0 });
		expect(store.stored).toHaveLength(4);
	});

	it("honours --limit and --since, newest transcript first", async () => {
		const older = `${dir}/2026-11-08T10-00-00-000Z_old.jsonl`;
		const store = archiveFake({ files: { [PATH]: file(four), [older]: { ...file(four), mtime: MTIME - 86_400_000 } } });
		const limited = await archiveBackfill({ client: store.client, home: HOME, dryRun: true, limit: 1 });
		expect(limited).toMatchObject({ considered: 1, chunks: 4 });
		const recent = await archiveBackfill({ client: store.client, home: HOME, dryRun: true, since: new Date(MTIME - 1000) });
		expect(recent).toMatchObject({ listed: 1, considered: 1 });
	});

	it("counts one unreadable transcript as failed and still writes the rest", async () => {
		const other = `${dir}/2026-11-08T10-00-00-000Z_other.jsonl`;
		const store = archiveFake({ files: { [PATH]: file(four), [other]: { ...file(four), mtime: MTIME - 1000 } } });
		store.failure.contentOf = PATH;
		const report = await archiveBackfill({ client: store.client, home: HOME });
		expect(report).toMatchObject({ considered: 2, failed: 1, sessionsWritten: 1, chunks: 4 });
		expect(new Set(store.inserts.map((write) => write.values[2]))).toEqual(new Set([other]));
	});

	it("refuses with a clear error when there is no store to read", async () => {
		const client = openArchiveClient({ env: {}, readFile: () => undefined });
		await expect(archiveBackfill({ client })).rejects.toThrow("no connection string");
	});

	describe("archiveWriteFact and archiveBackend.save", () => {
		it("writes a redacted fact with context and soft repository/scope metadata, idempotently on content", async () => {
			const seen: Statement[] = [];
			const client = openArchiveClient({
				env: { SESSIONS_DB_URL: "postgres://stub/db" },
				connect: () => ({
					unsafe: async <T>(text: string, values?: readonly unknown[]) => {
						seen.push({ text, values: values ?? [] });
						return [] as unknown as T[];
					},
				}),
			});
			const first = await archiveWriteFact(
				client,
				"/Users/x/Developer/Software-Automation-Holdings/zyins-api",
				{
					content: "Prefix git with MISE_OFFLINE=1 (token ghp_" + "a1".repeat(18) + ")",
					context: "hk pre-commit gate",
					scope: archiveScopeOf("/Users/x/Developer/Software-Automation-Holdings/zyins-api", "/Users/x"),
					repository: "zyins-api",
					source: "coding-agent-learn",
					sessionPath: "/s/1.jsonl",
				},
				{ now: () => new Date("2026-11-10T12:00:00.000Z") },
			);
			expect(first.stored).toBe(1);
			expect(first.id).toBe(
				archiveFactId(
					"coding-agent-learn",
					"/s/1.jsonl",
					"[context: hk pre-commit gate]\nPrefix git with MISE_OFFLINE=1 (token [REDACTED])",
				),
			);
			expect(seen[0]?.values).toEqual([
				first.id,
				"coding-agent-learn",
				"/s/1.jsonl",
				"zyins-api",
				"sah",
				"2026-11-10T12:00:00.000Z",
				"[context: hk pre-commit gate]\nPrefix git with MISE_OFFLINE=1 (token [REDACTED])",
				null,
			]);

			const backend = createArchiveBackend({ client });
			const globalSaved = await backend.save?.(
				{ agentDir: "/Users/x/.omp/agent", cwd: "/Users/x/Developer/Personal/oh-my-pi" },
				{ content: "Cross-project fact", scope: "global", source: "coding-agent-retain" },
			);
			expect(globalSaved?.stored).toBe(1);
			expect(seen[1]?.values[4]).toBe("global");

			const blank = await backend.save?.(
				{ agentDir: "/Users/x/.omp/agent", cwd: "/Users/x/Developer/Personal/oh-my-pi" },
				{ content: "   " },
			);
			expect(blank?.stored).toBe(0);
		});
	});
});
