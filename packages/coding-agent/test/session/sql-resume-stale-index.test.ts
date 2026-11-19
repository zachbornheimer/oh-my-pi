/**
 * A SQL-backed `--resume` must find a session another process wrote after this
 * process loaded its startup index. The index is a snapshot; a miss against it
 * is not proof the session is absent from the shared store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	resetSessionStorageForTesting,
	resolveSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const stubSettings = { get: () => undefined } as unknown as Settings;
const DB_URL_ENV = "SESSIONS_DB_URL";

function resumeArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		unrecognizedFlags: [],
	} as unknown as Args;
}

describe("createSessionManager --resume against a stale SQL index", () => {
	let tempDir: string;
	let previousUrl: string | undefined;
	let writer: SqlSessionStorage;
	const writerClients: InstanceType<typeof SQL>[] = [];

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sql-resume-"));
		setAgentDir(path.join(tempDir, "agent"));
		previousUrl = process.env[DB_URL_ENV];
		const dbFile = path.join(tempDir, "sessions.db");
		process.env[DB_URL_ENV] = `sqlite://${dbFile}`;
		resetSessionStorageForTesting();
		const writerClient = new SQL(`sqlite://${dbFile}`);
		writerClients.push(writerClient);
		writer = await SqlSessionStorage.create({ client: writerClient });
	});

	afterEach(async () => {
		if (previousUrl === undefined) delete process.env[DB_URL_ENV];
		else process.env[DB_URL_ENV] = previousUrl;
		resetSessionStorageForTesting();
		__resetDirsFromEnvForTests();
		for (const client of writerClients.splice(0)) await client.close().catch(() => undefined);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function writeSessionAfterReaderLoadedIndex(cwd: string, sessionDir: string): Promise<string> {
		fs.mkdirSync(cwd, { recursive: true });
		// The resuming process loads its index (and caches the storage) before the session exists.
		await resolveSessionStorage();
		const manager = SessionManager.create(cwd, sessionDir, writer);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "written by another process" }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await manager.flush();
		await writer.drain();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		return file;
	}

	it("opens a session by full path that appeared after the index was loaded", async () => {
		const cwd = path.join(tempDir, "proj");
		const sessionFile = await writeSessionAfterReaderLoadedIndex(cwd, path.join(tempDir, "sessions", "proj"));

		const manager = await createSessionManager(resumeArgs(sessionFile), cwd, stubSettings);

		expect(manager?.getSessionFile()).toBe(sessionFile);
	});

	it("opens a session by id that appeared after the index was loaded", async () => {
		const cwd = path.join(tempDir, "proj");
		const sessionDir = path.join(tempDir, "sessions", "proj");
		const sessionFile = await writeSessionAfterReaderLoadedIndex(cwd, sessionDir);
		const id = /_([^_]+)\.jsonl$/.exec(path.basename(sessionFile))?.[1] ?? "";

		const manager = await createSessionManager(resumeArgs(id, sessionDir), cwd, stubSettings);

		expect(manager?.getSessionFile()).toBe(sessionFile);
	});

	it("still reports a session that exists nowhere as not found", async () => {
		await resolveSessionStorage();
		const missing = createSessionManager(resumeArgs("01a1f0fb-0000-0000-0000-000000000000"), tempDir, stubSettings);
		await expect(missing).rejects.toBeInstanceOf(SessionResolutionError);
	});
});
