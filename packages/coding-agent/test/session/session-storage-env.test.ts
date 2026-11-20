/**
 * `resolveSessionStorage` connection lifecycle: a SQL store that could not
 * connect (a sleeping serverless database compute, a rotated password the environment has
 * since been fixed for) must be retried with bounded backoff, never cached as
 * a permanent failure for the rest of the process.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resetSessionStorageForTesting,
	resolveSessionStorage,
	sqlPoolOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

const SESSIONS_DB_URL_ENV = "SESSIONS_DB_URL";

describe("resolveSessionStorage", () => {
	let tempDir: string;
	let previousUrl: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-storage-env-"));
		previousUrl = process.env[SESSIONS_DB_URL_ENV];
	});

	afterEach(() => {
		if (previousUrl === undefined) delete process.env[SESSIONS_DB_URL_ENV];
		else process.env[SESSIONS_DB_URL_ENV] = previousUrl;
		resetSessionStorageForTesting();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("retries a connection that fails transiently within one resolve, with bounded backoff", async () => {
		const dbDir = path.join(tempDir, "late");
		process.env[SESSIONS_DB_URL_ENV] = `sqlite://${path.join(dbDir, "sessions.db")}`;
		const backoffs: number[] = [];
		resetSessionStorageForTesting({
			// The database becomes reachable while the first backoff elapses.
			sleep: async ms => {
				backoffs.push(ms);
				fs.mkdirSync(dbDir, { recursive: true });
			},
		});

		const storage = await resolveSessionStorage();
		expect(storage).toBeInstanceOf(SqlSessionStorage);
		expect(backoffs).toHaveLength(1);
	});

	it("does not cache a failed connection for the rest of the process", async () => {
		const dbDir = path.join(tempDir, "missing");
		process.env[SESSIONS_DB_URL_ENV] = `sqlite://${path.join(dbDir, "sessions.db")}`;
		const backoffs: number[] = [];
		resetSessionStorageForTesting({
			sleep: async ms => {
				backoffs.push(ms);
			},
		});

		// A store that stays unreachable degrades the caller to local files instead of failing it.
		expect(await resolveSessionStorage()).toBeInstanceOf(FileSessionStorage);
		// Bounded: a dead database fails the caller after a fixed number of attempts.
		expect(backoffs.length).toBeLessThan(5);

		fs.mkdirSync(dbDir);
		const storage = await resolveSessionStorage();
		expect(storage).toBeInstanceOf(SqlSessionStorage);
		// A successful store is still shared process-wide.
		expect(await resolveSessionStorage()).toBe(storage);
	});
});

describe("resolveSessionStorage with an unreachable server database", () => {
	afterEach(() => {
		delete process.env[SESSIONS_DB_URL_ENV];
		resetSessionStorageForTesting();
	});

	it("falls back to local files when the postgres host refuses connections", async () => {
		process.env[SESSIONS_DB_URL_ENV] = "postgresql://u:p@127.0.0.1:1/x";
		resetSessionStorageForTesting({ sleep: async () => {} });
		expect(await resolveSessionStorage()).toBeInstanceOf(FileSessionStorage);
	});

	it("names the fallback on stderr once per process", async () => {
		process.env[SESSIONS_DB_URL_ENV] = "postgresql://u:p@127.0.0.1:1/x";
		resetSessionStorageForTesting({ sleep: async () => {} });
		const written: string[] = [];
		const write = spyOn(process.stderr, "write").mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		try {
			await resolveSessionStorage();
			await resolveSessionStorage();
		} finally {
			write.mockRestore();
		}
		const notices = written.filter(line => line.includes("Session store unreachable"));
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("local files");
	});
});

describe("sqlPoolOptions", () => {
	it("bounds server database pools so idle connections close instead of staying open forever", () => {
		const bounded = { max: 2, idleTimeout: 5, connectionTimeout: 15 };
		expect(sqlPoolOptions("postgresql://u:p@host/db")).toEqual(bounded);
		expect(sqlPoolOptions("postgres://u:p@host/db")).toEqual(bounded);
		expect(sqlPoolOptions("mysql://u:p@host/db")).toEqual(bounded);
	});

	it("leaves embedded SQLite and unparseable URLs unpooled", () => {
		expect(sqlPoolOptions("sqlite:///tmp/sessions.db")).toEqual({});
		expect(sqlPoolOptions("not a url")).toEqual({});
	});
});
