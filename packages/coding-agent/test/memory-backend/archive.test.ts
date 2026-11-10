import { describe, expect, it } from "bun:test";
import { archiveRepositoryOf } from "../../src/memory-backend/archive/backend";
import { openArchiveClient } from "../../src/memory-backend/archive/client";
import {
	ARCHIVE_RETAIN_CHUNK_CHARS,
	ArchiveRetainer,
	archiveChunkId,
	archiveChunksOf,
	archiveScopeOf,
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
});

describe("ArchiveRetainer", () => {
	const SESSION_PATH = "/sessions/2026-11-09_abc.jsonl";
	type Statement = { text: string; values: readonly unknown[] };

	/** A store that answers the cursor query with `highest`, records every other statement, and refuses while `failure.error` is set. */
	const fakeStore = (highest = -1) => {
		const writes: Statement[] = [];
		const cursorReads: Statement[] = [];
		const failure: { error?: Error } = {};
		const client = openArchiveClient({
			env: { SESSIONS_DB_URL: "postgres://stub/db" },
			connect: () => ({
				unsafe: async <T>(text: string, values: readonly unknown[] = []) => {
					if (failure.error) throw failure.error;
					if (text.includes("max(chunk_index)")) {
						cursorReads.push({ text, values });
						return [{ highest }] as T[];
					}
					writes.push({ text, values });
					return [] as T[];
				},
			}),
		});
		return { client, writes, cursorReads, failure };
	};

	/** A session whose transcript is `entries`, which a test may grow between calls. */
	const fakeSession = (entries: unknown[] = [], sessionFile: string | null = SESSION_PATH) => ({
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
	const retainer = (
		store: ReturnType<typeof fakeStore>,
		session: ReturnType<typeof fakeSession>,
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
		const store = fakeStore();
		const session = fakeSession([turn("user", "first question"), turn("assistant", "first answer")]);
		expect(await retainer(store, session).retain()).toBe(0);
		expect(store.writes).toEqual([]);
	});

	it("writes one bound-parameter row per chunk once the threshold is crossed", async () => {
		const store = fakeStore();
		const session = fakeSession([
			turn("user", "first question"),
			turn("assistant", "first answer"),
			turn("user", "second question"),
			turn("assistant", "second answer"),
		]);
		expect(await retainer(store, session).retain()).toBe(4);
		expect(store.cursorReads[0]?.values).toEqual([SESSION_PATH]);
		expect(store.writes).toHaveLength(4);
		store.writes.forEach((write, index) => {
			const [id, source, sessionPath, repository, scope, occurredAt, chunkIndex, body, embedding] = write.values;
			expect(write.text).toContain("on conflict (id) do nothing");
			expect(write.text).toContain("$8");
			expect(write.text).not.toContain("question");
			expect(id).toBe(archiveChunkId(SESSION_PATH, index));
			expect(source).toBe(SESSION_PATH);
			expect(sessionPath).toBe(SESSION_PATH);
			expect(repository).toBe("oh-my-pi");
			expect(scope).toBe("personal");
			expect(occurredAt).toBe((session.entries[index] as { timestamp: string }).timestamp);
			expect(chunkIndex).toBe(index);
			expect(embedding).toBeNull();
			expect(String(body)).toStartWith(index % 2 === 0 ? "[role: user]\n" : "[role: assistant]\n");
		});
	});

	it("does not write again for a transcript it has already retained", async () => {
		const store = fakeStore();
		const session = fakeSession([
			turn("user", "first question"),
			turn("assistant", "first answer"),
			turn("user", "second question"),
			turn("assistant", "second answer"),
		]);
		const subject = retainer(store, session);
		await subject.retain();
		expect(await subject.retain()).toBe(0);
		expect(store.writes).toHaveLength(4);
	});

	it("writes only the chunks past what the store already holds for a resumed session", async () => {
		const store = fakeStore(3);
		const session = fakeSession([
			turn("user", "first question"),
			turn("assistant", "first answer"),
			turn("user", "second question"),
			turn("assistant", "second answer"),
			turn("user", "third question"),
			turn("assistant", "third answer"),
		]);
		expect(await retainer(store, session).retain()).toBe(2);
		expect(store.writes.map((write) => write.values[6])).toEqual([4, 5]);
	});

	it("leaves embedding null when the embedder fails and stores the vector when it answers", async () => {
		const entries = [turn("user", "first question"), turn("assistant", "first answer")];
		const failing = fakeStore();
		await retainer(failing, fakeSession(entries), {
			everyNTurns: () => 1,
			embed: async () => {
				throw new Error("no model");
			},
		}).retain();
		expect(failing.writes.map((write) => write.values[8])).toEqual([null, null]);
		const working = fakeStore();
		await retainer(working, fakeSession(entries), { everyNTurns: () => 1, embed: async () => [0.5, -1] }).retain();
		expect(working.writes.map((write) => write.values[8])).toEqual(["[0.5,-1]", "[0.5,-1]"]);
	});

	it("writes nothing when retention is switched off or the session has no transcript file", async () => {
		const entries = [turn("user", "first question"), turn("user", "second question")];
		const off = fakeStore();
		expect(await retainer(off, fakeSession(entries), { enabled: () => false }).retain()).toBe(0);
		const unsaved = fakeStore();
		expect(await retainer(unsaved, fakeSession(entries, null)).retain()).toBe(0);
		expect(off.writes).toEqual([]);
		expect(unsaved.writes).toEqual([]);
	});

	it("swallows a store failure, and retries the same turns on the next call", async () => {
		const entries = [turn("user", "first question"), turn("assistant", "first answer"), turn("user", "second one")];
		const store = fakeStore();
		store.failure.error = new Error("connection refused");
		const subject = retainer(store, fakeSession(entries));
		expect(await subject.retain()).toBe(0);
		expect(store.writes).toEqual([]);

		store.failure.error = undefined;
		expect(await subject.retain()).toBe(3);
		expect(store.writes).toHaveLength(3);
	});
});
