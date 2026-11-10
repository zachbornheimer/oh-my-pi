import { describe, expect, it } from "bun:test";
import { archiveRepositoryOf } from "../../src/memory-backend/archive/backend";
import { openArchiveClient } from "../../src/memory-backend/archive/client";
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
	it("cites repository, kind and date, and stays inside the budget", () => {
		const block = archiveContextBlock(
			[
				hit({ repository: "zyins", kind: "fact", body: "the fix was x", at: "2026-11-01T00:00:00.000Z" }),
				hit({ id: "id-2", repository: "webmaster", kind: "chunk", body: "y", at: "2026-11-02T00:00:00.000Z" }),
			],
			500,
		);
		expect(block).toContain("[zyins · fact · 2026-11-01] the fix was x");
		expect(block).toContain("[webmaster · chunk · 2026-11-02] y");
		expect(block!.length).toBeLessThanOrEqual(500 + 200);
	});
	it("drops an entry that would not fit rather than cutting it", () => {
		const long = "z".repeat(400);
		const block = archiveContextBlock([hit({ body: long }), hit({ id: "b", body: long })], 420);
		expect(block).toContain("z");
		const entries = block!.split("\n").filter((line: string) => line.startsWith("- ")).length;
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
});
