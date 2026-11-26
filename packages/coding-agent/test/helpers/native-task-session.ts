import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./agent-session-setup";

export async function withNativeTaskSession(
	extension: ExtensionFactory,
	run: (session: AgentSession) => Promise<void>,
	toolNames = ["task"],
): Promise<void> {
	const originalStateDirectory = process.env.OMP_ATASK_STATE_DIR;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-task-extension-"));
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	try {
		authStorage = createInMemoryAuthStorage();
		process.env.OMP_ATASK_STATE_DIR = directory;
		authStorage.keys.setRuntime("anthropic", "native-task-test-key");
		const result = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			authStorage,
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			modelRegistry: new ModelRegistry(authStorage, path.join(directory, "models.yml")),
			settings: Settings.isolated({ "async.widgets": false }),
			sessionManager: SessionManager.inMemory(directory),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames,
		});
		session = result.session;
		await run(session);
	} finally {
		try {
			await session?.dispose();
		} finally {
			try {
				authStorage?.close();
			} finally {
				try {
					await fs.rm(directory, { recursive: true, force: true });
				} finally {
					if (originalStateDirectory === undefined) delete process.env.OMP_ATASK_STATE_DIR;
					else process.env.OMP_ATASK_STATE_DIR = originalStateDirectory;
				}
			}
		}
	}
}
