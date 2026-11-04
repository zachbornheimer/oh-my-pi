import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

/**
 * Persist a session whose header cwd is `foreignCwd`, like one recorded on
 * another machine, without needing that directory to exist here.
 */
async function writeSessionRecordedElsewhere(foreignCwd: string, sessionDir: string): Promise<string> {
	const session = SessionManager.create(foreignCwd, sessionDir);
	session.appendMessage({ role: "user", content: "recorded elsewhere", timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected persisted session file");
	await session.close();
	return file;
}

describe("SessionManager.open resume from another machine's home", () => {
	let testAgentDir: string;
	let homedir: ReturnType<typeof spyOn>;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(os.homedir(), ".omp", "agent");

	beforeEach(async () => {
		// Force a deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%foreign-home-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-foreign-home-"));
		setAgentDir(testAgentDir);
	});

	afterEach(async () => {
		// A temp home whose basename matches the user segment recorded under /home:
		// `os.homedir()` is this machine's home at resume time, so mock it per test.
		homedir?.mockRestore();
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("adopts the local counterpart of a cwd recorded under another machine's home", async () => {
		const home = await fsp.mkdtemp(path.join(testAgentDir, "home-"));
		homedir = spyOn(os, "homedir").mockReturnValue(home);
		const localProject = path.join(home, "proj");
		await fsp.mkdir(localProject, { recursive: true });
		const launchCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-foreign-launch-"));
		const recordedCwd = `/home/${path.basename(home)}/proj`;

		const file = await writeSessionRecordedElsewhere(recordedCwd, path.join(testAgentDir, "sessions"));
		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launchCwd });
		try {
			expect(manager.getCwd()).toBe(path.resolve(localProject));
			expect(manager.getRecordedCwd()).toBe(path.resolve(localProject));
			expect(manager.getForeignHomeRemap()).toEqual({
				from: path.resolve(recordedCwd),
				to: path.resolve(localProject),
			});
			// The adopted cwd is persisted into the header, not the recorded literal.
			manager.appendMessage({ role: "user", content: "resumed here", timestamp: 2 });
			await manager.flush();
			const header = fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(line => line.trim())
				.map(line => JSON.parse(line) as { type?: string; cwd?: string })
				.find(entry => entry.type === "session");
			expect(header?.cwd).toBe(path.resolve(localProject));
		} finally {
			await manager.close();
		}
	});

	it("still falls back to the launch cwd when the foreign cwd has no local counterpart", async () => {
		const home = await fsp.mkdtemp(path.join(testAgentDir, "home-"));
		homedir = spyOn(os, "homedir").mockReturnValue(home);
		const launchCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-foreign-launch-"));
		const recordedCwd = `/home/${path.basename(home)}/nowhere`;

		const file = await writeSessionRecordedElsewhere(recordedCwd, path.join(testAgentDir, "sessions"));
		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launchCwd });
		try {
			expect(manager.getCwd()).toBe(path.resolve(launchCwd));
			expect(manager.getRecordedCwd()).toBe(path.resolve(recordedCwd));
			expect(manager.getForeignHomeRemap()).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	it("keeps an enterable recorded cwd unchanged without a remap", async () => {
		const home = await fsp.mkdtemp(path.join(testAgentDir, "home-"));
		homedir = spyOn(os, "homedir").mockReturnValue(home);
		const project = path.join(home, "proj");
		await fsp.mkdir(project, { recursive: true });
		const launchCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-foreign-launch-"));

		const file = await writeSessionRecordedElsewhere(project, path.join(testAgentDir, "sessions"));
		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launchCwd });
		try {
			expect(manager.getCwd()).toBe(path.resolve(project));
			expect(manager.getForeignHomeRemap()).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	it("remaps additional workspace directories recorded under the foreign home", async () => {
		const home = await fsp.mkdtemp(path.join(testAgentDir, "home-"));
		homedir = spyOn(os, "homedir").mockReturnValue(home);
		const localProject = path.join(home, "proj");
		const localSibling = path.join(home, "sibling");
		await fsp.mkdir(localProject, { recursive: true });
		await fsp.mkdir(localSibling, { recursive: true });
		const launchCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-foreign-launch-"));
		const recordedCwd = `/home/${path.basename(home)}/proj`;

		const file = await writeSessionRecordedElsewhere(recordedCwd, path.join(testAgentDir, "sessions"));
		// Seed the header's additionalDirectories with a foreign root and an unmappable one.
		const lines = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.map(line => {
				if (!line.trim()) return line;
				const entry = JSON.parse(line) as { type?: string; additionalDirectories?: string[] };
				if (entry.type === "session") {
					entry.additionalDirectories = [
						`/home/${path.basename(home)}/sibling`,
						`/home/${path.basename(home)}/missing`,
					];
				}
				return JSON.stringify(entry);
			});
		fs.writeFileSync(file, lines.join("\n"));

		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launchCwd });
		try {
			expect(manager.getAdditionalDirectories()).toEqual([
				path.resolve(localSibling),
				`/home/${path.basename(home)}/missing`,
			]);
		} finally {
			await manager.close();
		}
	});
});
