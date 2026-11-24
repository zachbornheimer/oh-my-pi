import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	resetSessionStorageForTesting,
	resolveSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { listAllSessionsForPicker, listSessionsForPicker } from "@oh-my-pi/pi-coding-agent/session/session-listing";

/**
 * A title is not a path. `omp --resume "AGENTS: Untangle ~/.agents symlink via"` contains a `/`, and a
 * key with a `/` was opened as a session file. A key is a path only when that file or row exists; every
 * other key is an id prefix or a title, looked up in the storage the session was written to.
 */
describe("createSessionManager --resume <partial title> over SQL storage", () => {
	const stubSettings = { get: () => undefined } as unknown as Settings;
	const title = "AGENTS: Untangle ~/.agents symlink via mise dot";
	let dbFile: string;
	let sessionDir: string;
	let savedUrl: string | undefined;
	let wanted: string;

	function assistantReply(): AssistantMessage {
		return {
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function resumeArgs(resume: string): Args {
		return {
			resume,
			sessionDir,
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			unrecognizedFlags: [],
			invalidFlagValues: [],
		};
	}

	beforeEach(async () => {
		const root = path.join(os.tmpdir(), `resume-sql-${Snowflake.next()}`);
		dbFile = path.join(root, "sessions.sqlite");
		sessionDir = path.resolve(root, "sessions");
		savedUrl = process.env.SESSIONS_DB_URL;
		mkdirSync(path.dirname(dbFile), { recursive: true });
		const url = `sqlite://${dbFile}`;
		const client = new SQL(url);
		const storage = await SqlSessionStorage.create({ client });
		const manager = SessionManager.create(root, sessionDir, storage);
		manager.appendMessage(assistantReply());
		await manager.setSessionName(title, "user");
		await manager.flush();
		await storage.drain();
		wanted = manager.getSessionFile() as string;
		await manager.close();
		await client.end();
		process.env.SESSIONS_DB_URL = url;
		resetSessionStorageForTesting();
	});

	afterEach(() => {
		if (savedUrl === undefined) delete process.env.SESSIONS_DB_URL;
		else process.env.SESSIONS_DB_URL = savedUrl;
		resetSessionStorageForTesting();
	});

	it("opens the session for a partial title without a slash", async () => {
		const opened = await createSessionManager(resumeArgs("AGENTS: Untangle"), "/work/elsewhere", stubSettings);
		expect(opened?.getSessionFile()).toBe(wanted);
		await opened?.close();
	});

	it("opens the session for a partial title that contains a slash", async () => {
		const opened = await createSessionManager(
			resumeArgs("AGENTS: Untangle ~/.agents symlink via"),
			"/work/elsewhere",
			stubSettings,
		);
		expect(opened?.getSessionFile()).toBe(wanted);
		await opened?.close();
	});

	it("still opens a session by its file path", async () => {
		const opened = await createSessionManager(resumeArgs(wanted), "/work/elsewhere", stubSettings);
		expect(opened?.getSessionFile()).toBe(wanted);
		await opened?.close();
	});

	it("reports a missing session file path as not found", async () => {
		await expect(
			createSessionManager(resumeArgs(path.join(sessionDir, "missing.jsonl")), "/work/elsewhere", stubSettings),
		).rejects.toThrow("not found");
	});
	it("opens remote-only SQL picker rows before per-session scans, including all-project scope", async () => {
		const storage = await resolveSessionStorage();
		const prefixes = spyOn(storage, "readTextPrefixes");
		const originalRead = storage.readTextSlices.bind(storage);
		const gate = Promise.withResolvers<void>();
		const reading = Promise.withResolvers<void>();
		const read = spyOn(storage, "readTextSlices").mockImplementation(async (...args) => {
			reading.resolve();
			await gate.promise;
			return originalRead(...args);
		});
		try {
			const pending = listSessionsForPicker(sessionDir, storage, new Set());
			await reading.promise;
			expect(prefixes).toHaveBeenCalledTimes(1);
			const listing = await pending;
			expect(listing.sessions.map(session => [session.path, session.title])).toEqual([[wanted, title]]);
			const global = await listAllSessionsForPicker(storage, new Set(), path.dirname(sessionDir));
			expect(global.sessions.map(session => session.path)).toEqual([wanted]);
			gate.resolve();
			await Promise.all([listing.complete, global.complete]);
		} finally {
			gate.resolve();
			read.mockRestore();
			prefixes.mockRestore();
		}
	});

	it("completes SQL listings with untitled sessions and pinned empty sessions", async () => {
		const storage = await resolveSessionStorage();
		const root = path.dirname(sessionDir);
		const untitled = SessionManager.create(root, sessionDir, storage);
		untitled.appendMessage(assistantReply());
		await untitled.flush();
		const untitledFile = untitled.getSessionFile() as string;
		await untitled.close();
		const empty = SessionManager.create(root, sessionDir, storage);
		await empty.ensureOnDisk();
		const emptyFile = empty.getSessionFile() as string;
		const emptyId = empty.getSessionId();
		await empty.close();
		const listing = await listSessionsForPicker(sessionDir, storage, new Set([emptyId]));
		expect(listing.sessions.map(session => session.path)).toEqual([wanted]);
		expect((await listing.complete).map(session => session.path)).toContain(untitledFile);
		expect((await listing.complete).map(session => session.path)).toContain(emptyFile);
	});

	it("reads only the session whose indexed title fits, and never re-reads the index for a title it finds", async () => {
		const client = new SQL(`sqlite://${dbFile}`);
		const storage = await SqlSessionStorage.create({ client });
		const other = SessionManager.create(path.dirname(dbFile), sessionDir, storage);
		other.appendMessage(assistantReply());
		await other.setSessionName("OPTIM: something unrelated", "user");
		await other.flush();
		await storage.drain();
		const otherFile = other.getSessionFile() as string;
		await other.close();
		await client.end();
		resetSessionStorageForTesting();

		const read = spyOn(IndexedSessionStorage.prototype, "readTextSlices");
		const refresh = spyOn(IndexedSessionStorage.prototype, "refresh");
		try {
			await resolveSessionStorage();
			refresh.mockClear();
			const opened = await createSessionManager(
				resumeArgs("AGENTS: Untangle ~/.agents symlink via"),
				"/work/elsewhere",
				stubSettings,
			);
			expect(opened?.getSessionFile()).toBe(wanted);
			await opened?.close();
			const scanned = read.mock.calls.map(([file]) => file);
			expect(scanned).not.toContain(otherFile);
			expect(refresh).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			refresh.mockRestore();
		}
	});
});
