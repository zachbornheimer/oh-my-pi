/**
 * Functional tests for {@link SqlSessionStorage}. Driven by a real
 * `Bun.SQL` SQLite instance (in-memory) so the storage exercises actual
 * SQL execution, not a hand-rolled mock. PostgreSQL/MySQL behaviour is
 * covered by the dialect-specific query suite below, which inspects the
 * statements built at construction.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	clearSessionListingCache,
	findSessionContinuation,
	findSessionFiles,
	getRecentSessions,
	listAllSessions,
	resolveResumableSession,
	resolveResumeTarget,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	resetSessionStorageForTesting,
	resolveSessionStorage,
	SQL_POOL_OPTIONS,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

async function createSqlite(): Promise<{ client: InstanceType<typeof SQL>; storage: SqlSessionStorage }> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage };
}

describe("SqlSessionStorage (SQLite backend)", () => {
	it("indexes writeText metadata and reads content asynchronously", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/a.jsonl",
		])) as Array<{ path: string; content: string }>;
		expect(rows).toEqual([{ path: "/sessions/p/a.jsonl", content: "line1\nline2\n" }]);

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
		await client.end();
	});

	it("create() warms the metadata index without selecting full content", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
		);
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			"/sessions/p/huge.jsonl",
			"0123456789",
			Date.now(),
		]);

		const queries: string[] = [];
		const wrapped: SqlSessionStorageClient = {
			options: { adapter: "sqlite" },
			unsafe(query, values) {
				queries.push(query);
				return client.unsafe(query, values);
			},
			transaction(callback) {
				return client.transaction(async transaction => callback(transaction));
			},
		};

		const storage = await SqlSessionStorage.create({ client: wrapped, createTable: false });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);

		const warmup = queries.find(query => query.startsWith("SELECT path"));
		expect(warmup).toContain("length(cast(content AS blob))");
		expect(warmup).not.toMatch(/SELECT\s+path,\s*content\b/i);
		expect(queries.some(query => /SELECT\s+content\s+AS\s+content/i.test(query))).toBe(false);
		await client.end();
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		expect(storage.listFilesSync("/dir", "*.jsonl").sort()).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);
		expect(storage.listFilesSync("/dir", "*.bak")).toEqual(["/dir/note.bak"]);
		await client.end();
	});

	it("listFilesSync supports 2-level bucket patterns and prefix wildcards in SqlSessionStorage and MemorySessionStorage", async () => {
		const { client, storage } = await createSqlite();
		const mem = new MemorySessionStorage();
		const paths = [
			"/root/bucket-a/2026-10-31T00-00-00-000Z_01a18f74-1d6a-735b-b87f-4faa0ffe8758.jsonl",
			"/root/bucket-b/2026-10-31T00-00-00-000Z_01b29999-0000-7000-8000-000000000000.jsonl",
			"/root/direct.jsonl",
			"/root/bucket-a/nested/deep.jsonl",
		];
		for (const p of paths) {
			await storage.writeText(p, "x");
			mem.writeTextSync(p, "x");
		}

		for (const s of [storage, mem]) {
			expect(s.listFilesSync("/root", "*/*.jsonl").sort()).toEqual([paths[0], paths[1]]);
			expect(s.listFilesSync("/root", "*/*_01a18f74*.jsonl")).toEqual([paths[0]]);
			expect(s.listFilesSync("/root/bucket-a", "*_01a18f74*.jsonl")).toEqual([paths[0]]);
		}
		await client.end();
	});

	it("listAllSessions, findSessionFiles, and resolveResumableSession discover cross-bucket SQL sessions", async () => {
		const { client, storage } = await createSqlite();
		const sessionsRoot = getSessionsDir();
		const sessionId = "01a18f74-1d6a-735b-b87f-4faa0ffe8758";
		const remotePath = `${sessionsRoot}/-Developer-Personal-capability-replicas-mastra/2026-10-31T00-55-14-026Z_${sessionId}.jsonl`;
		await storage.writeText(
			remotePath,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: sessionId,
					timestamp: "2026-10-31T00:55:14.026Z",
					cwd: "/Users/zbornheimer/Developer/Personal/capability-replicas/mastra",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-10-31T00:55:15.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n") + "\n",
		);

		const all = await listAllSessions(storage, sessionsRoot);
		expect(all.map(s => s.id)).toEqual([sessionId]);

		const found = await findSessionFiles("01a18f74", sessionsRoot, storage);
		expect(found).toEqual([remotePath]);

		const resolved = await resolveResumableSession(sessionId, "/tmp", undefined, storage);
		expect(resolved?.scope).toBe("global");
		expect(resolved?.session.id).toBe(sessionId);
		expect(resolved?.session.path).toBe(remotePath);
		await client.end();
	});

	it("findSessionFiles without an explicit storage finds a SQL-only session when SESSIONS_DB_URL is set", async () => {
		const dbFile = path.join(os.tmpdir(), `omp-find-${process.pid}-${Date.now()}.sqlite`);
		const previous = process.env.SESSIONS_DB_URL;
		process.env.SESSIONS_DB_URL = `sqlite://${dbFile}`;
		resetSessionStorageForTesting();
		try {
			const storage = await resolveSessionStorage();
			const sessionId = "01c0ffee-1d6a-735b-b87f-4faa0ffe8758";
			const sqlOnly = `${getSessionsDir()}/-sql-only-bucket/2026-11-01T00-00-00-000Z_${sessionId}.jsonl`;
			await storage.writeText(sqlOnly, "{}\n");
			expect(await findSessionFiles("01c0ffee")).toEqual([sqlOnly]);
		} finally {
			if (previous === undefined) delete process.env.SESSIONS_DB_URL;
			else process.env.SESSIONS_DB_URL = previous;
			resetSessionStorageForTesting();
			await fs.rm(dbFile, { force: true });
		}
	});

	it("resolveResumeTarget without an explicit storage resumes a SQL-only session when SESSIONS_DB_URL is set", async () => {
		const dbFile = path.join(os.tmpdir(), `omp-resume-${process.pid}-${Date.now()}.sqlite`);
		const previous = process.env.SESSIONS_DB_URL;
		process.env.SESSIONS_DB_URL = `sqlite://${dbFile}`;
		resetSessionStorageForTesting();
		try {
			const storage = await resolveSessionStorage();
			const sessionId = "01c0ffee-2d6a-735b-b87f-4faa0ffe8758";
			const sqlOnly = `${getSessionsDir()}/-sql-only-bucket/2026-11-01T00-00-00-000Z_${sessionId}.jsonl`;
			await storage.writeText(
				sqlOnly,
				[
					JSON.stringify({
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: sessionId,
						timestamp: "2026-11-01T00:00:00.000Z",
						cwd: "/tmp",
					}),
					JSON.stringify({
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: "2026-11-01T00:00:01.000Z",
						message: { role: "user", content: "hello", timestamp: 1 },
					}),
				].join("\n") + "\n",
			);
			const target = await resolveResumeTarget("01c0ffee-2d6a", "/tmp");
			expect(target?.session.path).toBe(sqlOnly);
		} finally {
			if (previous === undefined) delete process.env.SESSIONS_DB_URL;
			else process.env.SESSIONS_DB_URL = previous;
			resetSessionStorageForTesting();
			await fs.rm(dbFile, { force: true });
		}
	});

	it("writer.append appends to SQL after drain", async () => {
		const { client, storage } = await createSqlite();
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from SQL.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		await storage.drain();
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/session.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe('{"type":"session"}\n{"type":"message"}\n');

		await writer.close();
		await client.end();
	});

	it("flags='w' truncates both mirror and SQL row", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/keep.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe("fresh\n");
		await client.end();
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");
		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		await client.end();
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");

		// Force a SQL error: drop the table so the next append throws.
		await client.unsafe("DROP TABLE omp_session_files");
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow();
		expect(writer.getError()).toBeDefined();
		await client.end();
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files ORDER BY path`)) as Array<{
			path: string;
		}>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/other.jsonl"]);
		await client.end();
	});

	it("rename moves content and mtime atomically inside the mirror and the DB", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/renamed.jsonl", content: "payload\n" }]);
		await client.end();
	});

	it("rename overwrites an existing destination (parity with fs.rename)", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "from-a\n");
		await storage.writeText("/sessions/p/b.jsonl", "from-b\n");

		await storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");
		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/b.jsonl")).toBe("from-a\n");
		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/b.jsonl", content: "from-a\n" }]);
		await client.end();
	});

	it("rename to the same path preserves the row", async () => {
		const { client, storage } = await createSqlite();
		const sessionPath = "/sessions/p/same.jsonl";
		await storage.writeText(sessionPath, "keep-me\n");

		await storage.rename(sessionPath, sessionPath);

		expect(storage.existsSync(sessionPath)).toBe(true);
		expect(await storage.readText(sessionPath)).toBe("keep-me\n");

		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [sessionPath]);
		await expect(storage.rename(sessionPath, sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("rename rolls back destination deletion when moving the source fails", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(
			`CREATE TRIGGER reject_session_move BEFORE UPDATE OF path ON omp_session_files ` +
				`WHEN OLD.path = '${source}' BEGIN SELECT RAISE(ABORT, 'move rejected'); END`,
		);

		await expect(storage.rename(source, destination)).rejects.toThrow("move rejected");

		expect(await storage.readText(source)).toBe("source\n");
		expect(await storage.readText(destination)).toBe("destination\n");
		await client.end();
	});

	it("rename rejects an externally deleted source without deleting the destination", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [source]);

		await expect(storage.rename(source, destination)).rejects.toMatchObject({ code: "ENOENT" });

		expect(await storage.readText(destination)).toBe("destination\n");
		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: destination, content: "destination\n" }]);
		await client.end();
	});

	it("rename rejects a missing source, including a same-path rename", async () => {
		const { client, storage } = await createSqlite();

		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/new.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/missing.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await client.end();
	});

	it("refresh() reloads the mirror from SQL after out-of-band writes", async () => {
		const { client, storage } = await createSqlite();
		// Simulate a peer process inserting directly.
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			"/peer/x.jsonl",
			"from peer\n",
			Date.now() + 5_000,
		]);
		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);

		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
		await client.end();
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		await client.end();
	});

	it("persists title updates as indexed fields across storage reloads", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await SqlSessionStorage.create({ client });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		await client.end();
	});

	it("readTextSlices uses bounded SQL byte substrings instead of a full content select", async () => {
		const client = new SQL("sqlite::memory:");
		const queries: string[] = [];
		const wrapped: SqlSessionStorageClient = {
			options: { adapter: "sqlite" },
			unsafe(query, values) {
				queries.push(query);
				return client.unsafe(query, values);
			},
			transaction(callback) {
				return client.transaction(async transaction => callback(transaction));
			},
		};
		const storage = await SqlSessionStorage.create({ client: wrapped });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		queries.length = 0;
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("substr(cast(content AS blob)");
		expect(queries[0]).not.toMatch(/SELECT\s+content\s+AS\s+content/i);
		await client.end();
	});

	it("custom table name is honored", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		await storage.writeText("/sessions/p/x.jsonl", "hello\n");
		const rows = (await client.unsafe(`SELECT path, content FROM agent_sessions`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/x.jsonl", content: "hello\n" }]);
		await client.end();
	});

	it("rejects table names that aren't safe identifiers", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "drop table users; --" })).rejects.toThrow(
			/table name must match/,
		);
		await client.end();
	});

	it("LIKE special chars in artifact paths don't blow up the prefix sweep", async () => {
		const { client, storage } = await createSqlite();
		// Path containing `%`, `_`, and the escape char `#`.
		await storage.writeText("/sessions/p/odd%_#name.jsonl", "session\n");
		await storage.writeText("/sessions/p/odd%_#name/draft.txt", "sidecar");
		await storage.writeText("/sessions/p/sibling.jsonl", "untouched");

		await storage.deleteSessionWithArtifacts("/sessions/p/odd%_#name.jsonl");
		expect(storage.existsSync("/sessions/p/odd%_#name.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/odd%_#name/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/sibling.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files`)) as Array<{ path: string }>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/sibling.jsonl"]);
		await client.end();
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const { client, storage } = await createSqlite();
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("createTable: false skips the DDL (consumer manages migrations)", async () => {
		const client = new SQL("sqlite::memory:");
		// Pre-create the table with the expected schema.
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
		);
		const storage = await SqlSessionStorage.create({ client, createTable: false });
		await storage.writeText("/s/x.jsonl", "ok");
		expect(await storage.readText("/s/x.jsonl")).toBe("ok");
		await client.end();
	});

	it("create() on an up-to-date table runs no ALTER TABLE, so startup never takes the table's exclusive lock", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
		);
		const queries: string[] = [];
		const wrapped: SqlSessionStorageClient = {
			options: { adapter: "sqlite" },
			unsafe(query, values) {
				queries.push(query);
				return client.unsafe(query, values);
			},
			transaction(callback) {
				return client.transaction(async transaction => callback(transaction));
			},
		};
		await SqlSessionStorage.create({ client: wrapped });
		expect(queries.filter(query => /^\s*ALTER\s+TABLE/i.test(query))).toEqual([]);
		await client.end();
	});

	it("create() adds the title columns to a table created before they existed", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL)`,
		);
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/legacy.jsonl", "ok");
		const rows = (await client.unsafe(
			`SELECT path, title, title_source, title_updated_at FROM omp_session_files`,
		)) as Array<Record<string, unknown>>;
		expect(rows).toEqual([{ path: "/s/legacy.jsonl", title: null, title_source: null, title_updated_at: null }]);
		await client.end();
	});
});

// ---------------------------------------------------------------------------
// Dialect-specific statement coverage. We can't run a real Postgres/MySQL
// instance from the test process, so we instantiate a `Bun.SQL` client (which
// parses the URL but doesn't connect until the first query) and stub
// `client.unsafe` to capture the rendered SQL. This catches dialect-specific
// regressions in the query builder.
// ---------------------------------------------------------------------------

interface CapturedQuery {
	sql: string;
	values: unknown[] | undefined;
}

function capturingClient(adapter: "postgres" | "mysql"): {
	client: SqlSessionStorageClient;
	queries: CapturedQuery[];
} {
	const queries: CapturedQuery[] = [];
	const client: SqlSessionStorageClient = {
		options: { adapter },
		async unsafe(sql, values) {
			queries.push({ sql, values });
			return [];
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return { client, queries };
}

describe("SqlSessionStorage (dialect-specific SQL)", () => {
	it("PostgreSQL uses numbered placeholders and `||` concat", async () => {
		const { client, queries } = capturingClient("postgres");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/s/p.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("path TEXT PRIMARY KEY");
		expect(ddl?.sql).toContain("mtime_ms BIGINT");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("octet_length(content)");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const append = queries.find(q => q.sql.includes("ON CONFLICT") && q.sql.includes("||"));
		expect(append?.sql).toContain("$1");
		expect(append?.sql).toContain("$2");
		expect(append?.sql).toContain("$3");
		expect(append?.sql).toMatch(/content = \w+\.content \|\| excluded\.content/);

		expect(storage.adapter).toBe("postgres");
	});

	it("MySQL uses bound update values with `ON DUPLICATE KEY UPDATE` and `CONCAT()`", async () => {
		const { client, queries } = capturingClient("mysql");
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/replace.jsonl", "body\n");
		const writer = storage.openWriter("/s/m.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("VARCHAR(512)");
		expect(ddl?.sql).toContain("LONGTEXT");
		expect(ddl?.sql).toContain("ENGINE=InnoDB");
		expect(ddl?.sql).toContain("utf8mb4");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("length(content)");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const upserts = queries.filter(q => q.sql.includes("ON DUPLICATE KEY UPDATE"));
		expect(upserts).toHaveLength(2);
		expect(upserts.every(query => !/VALUES\(\w+\)/i.test(query.sql))).toBe(true);

		const replace = upserts.find(q => q.sql.includes("title_updated_at"));
		expect(replace?.values?.slice(0, 6)).toEqual([
			"/s/replace.jsonl",
			"body\n",
			expect.any(Number),
			null,
			null,
			null,
		]);
		expect(replace?.values?.slice(6)).toEqual(["body\n", expect.any(Number), null, null, null]);

		const append = upserts.find(q => q.sql.includes("CONCAT"));
		expect(append?.sql).toContain("CONCAT(content, ?)");
		expect(append?.values?.slice(0, 3)).toEqual(["/s/m.jsonl", "chunk\n", expect.any(Number)]);
		expect(append?.values?.slice(3)).toEqual(["chunk\n", expect.any(Number)]);
		expect(append?.sql).not.toContain("$1");

		expect(storage.adapter).toBe("mysql");
	});

	it("rejects clients reporting an unknown adapter without an override", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "weirdb" },
			async unsafe() {
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		await expect(SqlSessionStorage.create({ client })).rejects.toThrow(/unable to infer adapter/);
	});

	it("explicit `adapter` option overrides the reported adapter", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "" }, // empty / missing
			async unsafe() {
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client, adapter: "postgres" });
		expect(storage.adapter).toBe("postgres");
	});
});

// ---------------------------------------------------------------------------
// Connection bounds, SQL pushdown, and listing fast paths.
// ---------------------------------------------------------------------------

interface RecordingSqlite {
	client: InstanceType<typeof SQL>;
	wrapped: SqlSessionStorageClient;
	queries: CapturedQuery[];
	storage: SqlSessionStorage;
}

async function recordingSqlite(): Promise<RecordingSqlite> {
	const client = new SQL("sqlite::memory:");
	const queries: CapturedQuery[] = [];
	const wrapped: SqlSessionStorageClient = {
		options: { adapter: "sqlite" },
		unsafe(sql, values) {
			queries.push({ sql, values });
			return client.unsafe(sql, values);
		},
		transaction(callback) {
			return client.transaction(async transaction => callback(transaction));
		},
	};
	const storage = await SqlSessionStorage.create({ client: wrapped });
	queries.length = 0;
	return { client, wrapped, queries, storage };
}

function sessionRecord(id: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: "/tmp", ...extra })}\n`;
}

describe("SQL pool bounds", () => {
	it("caps the shared client at two connections that close after 5 idle seconds", () => {
		expect(SQL_POOL_OPTIONS).toEqual({ max: 2, idleTimeout: 5, connectionTimeout: 15 });
	});
});

describe("hasAssistantTurn pushdown", () => {
	const assistantLine = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`;
	const userLine = `${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`;

	it("answers in SQL without selecting the content body", async () => {
		const { client, queries, storage } = await recordingSqlite();
		await storage.writeText("/s/with.jsonl", `${userLine}${assistantLine}`);
		await storage.writeText("/s/without.jsonl", userLine);
		queries.length = 0;

		expect(await storage.hasAssistantTurn("/s/with.jsonl")).toBe(true);
		expect(await storage.hasAssistantTurn("/s/without.jsonl")).toBe(false);

		expect(queries).toHaveLength(2);
		for (const query of queries) {
			expect(query.sql).toMatch(/instr\(content, \?\)/i);
			expect(query.sql).not.toMatch(/SELECT\s+content\b/i);
		}
		await client.end();
	});

	it("does not mistake an escaped marker inside message text for an assistant record", async () => {
		const { client, storage } = await recordingSqlite();
		const quoted = `${JSON.stringify({ type: "message", message: { role: "user", content: '{"role":"assistant"}' } })}\n`;
		await storage.writeText("/s/quoted.jsonl", quoted);
		expect(await storage.hasAssistantTurn("/s/quoted.jsonl")).toBe(false);
		await client.end();
	});

	it("sees content queued by a not-yet-published synchronous write", async () => {
		const { client, storage } = await recordingSqlite();
		storage.writeTextSync("/s/pending.jsonl", assistantLine);
		expect(await storage.hasAssistantTurn("/s/pending.jsonl")).toBe(true);
		await client.end();
	});

	it("rejects with ENOENT for an unknown path", async () => {
		const { client, storage } = await recordingSqlite();
		await expect(storage.hasAssistantTurn("/s/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("PostgreSQL uses strpos with numbered placeholders, marker first", async () => {
		const queries: CapturedQuery[] = [];
		const client: SqlSessionStorageClient = {
			options: { adapter: "postgres" },
			async unsafe(sql, values) {
				queries.push({ sql, values });
				return sql.includes("strpos") ? Object.assign([{ found: 1 }], {}) : [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/p.jsonl", assistantLine);
		queries.length = 0;

		expect(await storage.hasAssistantTurn("/s/p.jsonl")).toBe(true);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.sql).toContain("strpos(content, $1)");
		expect(queries[0]?.sql).toContain("path = $2");
		expect(queries[0]?.values).toEqual(['"role":"assistant"', "/s/p.jsonl"]);
	});

	it("MySQL uses INSTR with positional placeholders", async () => {
		const queries: CapturedQuery[] = [];
		const client: SqlSessionStorageClient = {
			options: { adapter: "mysql" },
			async unsafe(sql, values) {
				queries.push({ sql, values });
				return /instr/i.test(sql) ? Object.assign([{ found: 0 }], {}) : [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/m.jsonl", userLine);
		queries.length = 0;

		expect(await storage.hasAssistantTurn("/s/m.jsonl")).toBe(false);
		expect(queries[0]?.sql).toMatch(/INSTR\(content, \?\)/);
		expect(queries[0]?.values).toEqual(['"role":"assistant"', "/s/m.jsonl"]);
	});
});

describe("indexed title and listing fast paths", () => {
	it("getSessionTitleSync reads the in-memory index", async () => {
		const { client, queries, storage } = await recordingSqlite();
		await storage.writeText("/s/p/a.jsonl", sessionRecord("a", "2026-11-01T00:00:00.000Z"));
		await storage.updateSessionTitle("/s/p/a.jsonl", { title: "Indexed title", source: "user", updatedAt: "t1" });
		queries.length = 0;

		expect(storage.getSessionTitleSync("/s/p/a.jsonl")).toBe("Indexed title");
		expect(storage.getSessionTitleSync("/s/p/missing.jsonl")).toBeUndefined();
		expect(queries).toEqual([]);
		await client.end();
	});

	it("getRecentSessions names indexed sessions without reading their bodies", async () => {
		const { client, queries, storage } = await recordingSqlite();
		const dir = "/s/recent";
		for (const [index, title] of ["First", "Second"].entries()) {
			const file = `${dir}/2026-11-01T00-00-0${index}-000Z_id${index}.jsonl`;
			await storage.writeText(file, sessionRecord(`id${index}`, `2026-11-01T00:00:0${index}.000Z`));
			await storage.updateSessionTitle(file, { title, source: "user", updatedAt: `t${index}` });
		}
		queries.length = 0;

		const recent = await getRecentSessions(dir, 4, storage);
		expect(recent.map(session => session.name).sort()).toEqual(["First", "Second"]);
		expect(queries).toEqual([]);
		await client.end();
	});

	it("resolveResumableSession opens a filename match without a batched header read of the scope", async () => {
		const { client, queries, storage } = await recordingSqlite();
		const root = getSessionsDir();
		const bucket = `${root}/-fastpath-bucket`;
		const targetId = "01f00000-0000-7000-8000-00000000aaaa";
		for (let index = 0; index < 5; index++) {
			const id = `01e00000-0000-7000-8000-00000000000${index}`;
			await storage.writeText(
				`${bucket}/2026-11-01T00-00-0${index}-000Z_${id}.jsonl`,
				sessionRecord(id, `2026-11-01T00:00:0${index}.000Z`),
			);
		}
		const targetPath = `${bucket}/2026-11-01T01-00-00-000Z_${targetId}.jsonl`;
		await storage.writeText(targetPath, sessionRecord(targetId, "2026-11-01T01:00:00.000Z"));
		queries.length = 0;

		const resolved = await resolveResumableSession(targetId.slice(0, 13), "/tmp", undefined, storage);
		expect(resolved?.session.path).toBe(targetPath);
		expect(queries.filter(query => /WHERE path IN/i.test(query.sql))).toEqual([]);

		queries.length = 0;
		expect(await resolveResumableSession("no-such-session", "/tmp", undefined, storage)).toBeUndefined();
		expect(queries.filter(query => /WHERE path IN/i.test(query.sql)).length).toBeGreaterThan(0);
		await client.end();
	});

	it("findSessionContinuation content-scans only the continuation chain of the session", async () => {
		const { client, queries, storage } = await recordingSqlite();
		const dir = "/s/chain";
		const root = `${dir}/2026-11-01T00-00-00-000Z_root.jsonl`;
		const child = `${dir}/2026-11-01T01-00-00-000Z_child.jsonl`;
		const grandchild = `${dir}/2026-11-01T02-00-00-000Z_grandchild.jsonl`;
		const stranger = `${dir}/2026-11-01T03-00-00-000Z_stranger.jsonl`;
		await storage.writeText(root, sessionRecord("root", "2026-11-01T00:00:00.000Z"));
		await storage.writeText(child, sessionRecord("child", "2026-11-01T01:00:00.000Z", { continuationOf: "root" }));
		await storage.writeText(
			grandchild,
			sessionRecord("grandchild", "2026-11-01T02:00:00.000Z", { continuationOf: "child" }),
		);
		await storage.writeText(
			stranger,
			sessionRecord("stranger", "2026-11-01T03:00:00.000Z", { continuationOf: "somewhere-else" }),
		);
		queries.length = 0;

		await findSessionContinuation(root, storage);

		const scanned = (file: string): boolean =>
			queries.some(query => !/WHERE path IN/i.test(query.sql) && (query.values ?? []).includes(file));
		expect(scanned(child)).toBe(true);
		expect(scanned(grandchild)).toBe(true);
		expect(scanned(stranger)).toBe(false);
		await client.end();
	});

	it("clearSessionListingCache drops per-storage scan caches so the next listing rescans", async () => {
		const { client, queries, storage } = await recordingSqlite();
		const dir = "/s/cache";
		const file = `${dir}/2026-11-01T00-00-00-000Z_cached.jsonl`;
		await storage.writeText(file, sessionRecord("cached", "2026-11-01T00:00:00.000Z"));
		const readsOf = (): number => queries.filter(query => (query.values ?? []).includes(file)).length;
		queries.length = 0;

		await resolveResumableSession("cached", "/tmp", dir, storage);
		expect(readsOf()).toBeGreaterThan(0);
		queries.length = 0;
		await resolveResumableSession("cached", "/tmp", dir, storage);
		expect(readsOf()).toBe(0);
		clearSessionListingCache();
		queries.length = 0;
		await resolveResumableSession("cached", "/tmp", dir, storage);
		expect(readsOf()).toBeGreaterThan(0);
		await client.end();
	});
});
