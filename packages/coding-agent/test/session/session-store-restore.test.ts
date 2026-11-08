import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import { type SessionStoreClient, restoreSessionFromStore } from "../../src/session/session-store-restore";

const ID = "01a1981c-4d84-7373-be8c-414088d6349b";
const STORED = '{"type":"message","text":"from the store"}\n';

function storeClient(rows: unknown[]): SessionStoreClient {
	return {
		async unsafe() {
			return rows;
		},
	};
}

function row(path: string, mtimeMs: number) {
	return { path, content: STORED, mtime_ms: mtimeMs };
}

describe("restoreSessionFromStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-store-restore-"));
	});
	afterEach(() => {
		mock.restore();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the stored transcript to its recorded path when the local copy is missing", async () => {
		const path = join(dir, "project", `2026-11-01T17-15-54-116Z_${ID}.jsonl`);

		const restored = await restoreSessionFromStore(ID, { client: storeClient([row(path, 1_000)]) });

		expect(restored).toBe(path);
		expect(await Bun.file(path).text()).toBe(STORED);
	});

	it("derives the id from a path key", async () => {
		const path = join(dir, `2026-11-01T17-15-54-116Z_${ID}.jsonl`);

		const restored = await restoreSessionFromStore(`/somewhere/else/${ID}.jsonl`.replace(`/${ID}`, `_${ID}`), {
			client: storeClient([row(path, 1_000)]),
		});

		expect(restored).toBe(path);
	});

	it("replaces a local copy the store has moved past", async () => {
		const path = join(dir, `2026-11-01T17-15-54-116Z_${ID}.jsonl`);
		writeFileSync(path, "stale\n");
		utimesSync(path, 1, 1);

		const restored = await restoreSessionFromStore(ID, { client: storeClient([row(path, 5_000_000)]) });

		expect(restored).toBe(path);
		expect(await Bun.file(path).text()).toBe(STORED);
	});

	it("leaves a copy that is already current alone", async () => {
		const path = join(dir, `2026-11-01T17-15-54-116Z_${ID}.jsonl`);
		writeFileSync(path, "current\n");

		const restored = await restoreSessionFromStore(ID, { client: storeClient([row(path, 1_000)]) });

		expect(restored).toBeUndefined();
		expect(await Bun.file(path).text()).toBe("current\n");
	});

	it("returns undefined when the store holds no row for the session", async () => {
		expect(await restoreSessionFromStore(ID, { client: storeClient([]) })).toBeUndefined();
	});

	it("ignores a row whose file name is not that session", async () => {
		const path = join(dir, `2026-11-01T17-15-54-116Z_11a1981c-4d84-7373-be8c-414088d6349b.jsonl`);

		expect(await restoreSessionFromStore(ID, { client: storeClient([row(path, 1_000)]) })).toBeUndefined();
	});

	it("does nothing without a store to read", async () => {
		expect(await restoreSessionFromStore(ID, { databaseUrl: "" })).toBeUndefined();
	});

	it("does nothing for a key that names no session", async () => {
		expect(await restoreSessionFromStore("not-a-session", { client: storeClient([]) })).toBeUndefined();
	});

	it("swallows a store failure so the resume can report its own", async () => {
		const failing: SessionStoreClient = {
			async unsafe() {
				throw new Error("connection refused");
			},
		};

		expect(await restoreSessionFromStore(ID, { client: failing })).toBeUndefined();
	});
	it("re-roots a row recorded under another machine's home onto this machine's home", async () => {
		const home = join(dir, "zbornheimer");
		mkdirSync(home, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(home);
		const recorded = `/home/zbornheimer/.omp/agent/sessions/-proj/2026-11-01T17-15-54-116Z_${ID}.jsonl`;
		const local = join(home, ".omp", "agent", "sessions", "-proj", `2026-11-01T17-15-54-116Z_${ID}.jsonl`);

		const restored = await restoreSessionFromStore(ID, { client: storeClient([row(recorded, 1_000)]) });

		expect(restored).toBe(local);
		expect(await Bun.file(local).text()).toBe(STORED);
	});

	it("keeps a row already under this machine's home at the path it records", async () => {
		const home = join(dir, "zbornheimer");
		mkdirSync(home, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(home);
		const path = join(home, ".omp", "agent", "sessions", "-proj", `2026-11-01T17-15-54-116Z_${ID}.jsonl`);
		const restored = await restoreSessionFromStore(ID, { client: storeClient([row(path, 1_000)]) });

		expect(restored).toBe(path);
	});

	it("asks in the dialect the client reports, so a SQLite or MySQL store is read too", async () => {
		const queries: string[] = [];
		const client: SessionStoreClient = {
			options: { adapter: "sqlite" },
			async unsafe(query: string) {
				queries.push(query);
				return [];
			},
		};

		expect(await restoreSessionFromStore(ID, { client })).toBeUndefined();

		expect(queries[0]).toContain("WHERE path LIKE ?");
	});

	it("reads the table it is told to, not the storage's default", async () => {
		const queries: string[] = [];
		const client: SessionStoreClient = {
			async unsafe(query: string) {
				queries.push(query);
				return [];
			},
		};

		await restoreSessionFromStore(ID, { client, table: "archived_sessions" });

		expect(queries[0]).toContain("FROM archived_sessions WHERE");
	});

	it("refuses a table name that is not a plain identifier", async () => {
		const client: SessionStoreClient = {
			async unsafe() {
				return [];
			},
		};

		expect(await restoreSessionFromStore(ID, { client, table: "s; DROP TABLE x" })).toBeUndefined();
	});
});
