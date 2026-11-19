import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetSessionStorageForTesting } from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

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
		manager.appendMessage({
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
		});
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
});
