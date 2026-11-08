import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SQL } from "bun";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { makeAssistantMessage } from "../session-manager/helpers";

import { setAgentDir } from "@oh-my-pi/pi-utils";

const stubSettings = { get: () => undefined } as unknown as Settings;

function resumeArgs(resume: string, sessionDir?: string): Args {
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

/** A session recorded on another machine: header cwd under that machine's home. */
async function recordedElsewhere(foreignCwd: string, sessionDir: string): Promise<{ file: string; content: string }> {
	const session = SessionManager.create(foreignCwd, sessionDir);
	session.appendMessage({ role: "user", content: "recorded elsewhere", timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	await session.flush();
	await session.close();
	return { file: path.basename(file), content: await fsp.readFile(file, "utf8") };
}

/** Run a statement against a throwaway SQLite file and close it. */
async function seedStore(dbPath: string, seed: (storage: SqlSessionStorage) => Promise<void>): Promise<void> {
	const client = new SQL(`sqlite:${dbPath}`);
	try {
		await seed(await SqlSessionStorage.create({ client }));
	} finally {
		await client.close();
	}
}

describe("--resume of a session that lives only in the shared store", () => {
	let tempDir: string;
	let homedir: Mock<typeof os.homedir> | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalStoreUrl = process.env.SESSIONS_DB_URL;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-resume-store-"));
		setAgentDir(path.join(tempDir, "agent"));
	});

	afterEach(async () => {
		homedir?.mockRestore();
		homedir = undefined;
		if (originalStoreUrl === undefined) delete process.env.SESSIONS_DB_URL;
		else process.env.SESSIONS_DB_URL = originalStoreUrl;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("opens the local counterpart of a path key the store recorded under another machine's home", async () => {
		const home = path.join(tempDir, "home");
		const localProject = path.join(home, "proj");
		await fsp.mkdir(localProject, { recursive: true });
		homedir = spyOn(os, "homedir").mockReturnValue(home);

		// The recorded transcript path names this user under /home, as a session
		// written on the Linux host does; only the store holds it on this machine.
		const foreignCwd = `/home/${path.basename(home)}/proj`;
		const recorded = await recordedElsewhere(foreignCwd, path.join(tempDir, "recorded-sessions"));
		const foreignFile = `/home/${path.basename(home)}/.omp/agent/sessions/-proj/${recorded.file}`;

		const dbPath = path.join(tempDir, "store.db");
		await seedStore(dbPath, async storage => {
			await storage.writeText(foreignFile, recorded.content);
		});
		process.env.SESSIONS_DB_URL = `sqlite:${dbPath}`;

		const manager = await createSessionManager(resumeArgs(foreignFile), tempDir, stubSettings);
		if (!manager) throw new Error("Expected a resumed session");
		try {
			expect(manager.getSessionFile()).toBe(path.join(home, ".omp", "agent", "sessions", "-proj", recorded.file));
			expect(manager.getCwd()).toBe(path.resolve(localProject));
		} finally {
			await manager.close();
		}
	}, 30_000);

	it("reports not found when the store holds nothing for the key and no local file exists", async () => {
		const home = path.join(tempDir, "home");
		await fsp.mkdir(home, { recursive: true });
		homedir = spyOn(os, "homedir").mockReturnValue(home);
		const dbPath = path.join(tempDir, "empty.db");
		await seedStore(dbPath, async () => {});
		process.env.SESSIONS_DB_URL = `sqlite:${dbPath}`;

		const missing = `/home/${path.basename(home)}/.omp/agent/sessions/-proj/2026-11-01T00-00-00-000Z_01a1981c-4d84-7373-be8c-414088d6349b.jsonl`;
		await expect(createSessionManager(resumeArgs(missing), tempDir, stubSettings)).rejects.toThrow(/not found/);
	}, 30_000);
});
