/**
 * Extensions report their goals to `/session` through `registerSessionGoals`. The panel is read-only
 * diagnostics, so one extension's broken goal state must not hide another's goals or stop it opening.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("registerSessionGoals", () => {
	let dir: TempDir;
	let sessions: AgentSession[];

	beforeEach(() => {
		dir = TempDir.createSync("@omp-session-goals-");
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) {
			await session.dispose();
			session.modelRegistry.authStorage.close();
		}
		dir.removeSync();
	});

	async function open(extensions: ExtensionFactory[]): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
			settings: Settings.isolated({}),
			sessionManager: SessionManager.inMemory(),
			extensions,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});
		sessions.push(session);
		return session;
	}

	it("collects every extension's goals, skipping a provider that throws", async () => {
		const session = await open([
			pi => pi.registerSessionGoals(() => [{ source: "autogoal", at: 1_000, goal: "ship the panel" }]),
			pi =>
				pi.registerSessionGoals(() => {
					throw new Error("goal state unreadable");
				}),
			pi => pi.registerSessionGoals(() => [{ source: "planner", at: 2_000, goal: "write the docs" }]),
		]);

		expect(session.extensionRunner?.getSessionGoals()).toEqual([
			{ source: "autogoal", at: 1_000, goal: "ship the panel" },
			{ source: "planner", at: 2_000, goal: "write the docs" },
		]);
	});

	it("reads the provider each time, so the panel shows the current goals", async () => {
		let goal = "first";
		const session = await open([pi => pi.registerSessionGoals(() => [{ source: "autogoal", at: 1_000, goal }])]);

		expect(session.extensionRunner?.getSessionGoals().map(row => row.goal)).toEqual(["first"]);
		goal = "second";
		expect(session.extensionRunner?.getSessionGoals().map(row => row.goal)).toEqual(["second"]);
	});
});
