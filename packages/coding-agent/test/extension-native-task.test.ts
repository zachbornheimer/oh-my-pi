import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { NativeTaskResult, NativeTaskSpec } from "@oh-my-pi/pi-coding-agent/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const TEST_TIMEOUT_MS = 30_000;
const TASK_NAME = "VerifyNativeHost";
const TASK_DESCRIPTION = "Maintain the extension-owned invariant";
const CHECK_FAILURE = "Proof service unavailable for VerifyNativeHost";
const BLOCKED_TASK_NAME = "UnavailableNativeHost";

const originalStateDirectory = process.env.OMP_ATASK_STATE_DIR;
let directory: string;
let session: AgentSession | undefined;
let authStorage: AuthStorage;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-task-extension-"));
	authStorage = createInMemoryAuthStorage();
	process.env.OMP_ATASK_STATE_DIR = directory;
	authStorage.keys.setRuntime("anthropic", "native-task-test-key");
});

afterEach(async () => {
	try {
		await session?.dispose();
	} finally {
		session = undefined;
		try {
			authStorage.close();
		} finally {
			try {
				await fs.rm(directory, { recursive: true, force: true });
			} finally {
				if (originalStateDirectory === undefined) delete process.env.OMP_ATASK_STATE_DIR;
				else process.env.OMP_ATASK_STATE_DIR = originalStateDirectory;
			}
		}
	}
});

async function createSession(extension: ExtensionFactory, toolNames = ["task"]): Promise<AgentSession> {
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
	return session;
}

function spec(proof: NativeTaskSpec["proof"], regression: NativeTaskSpec["regression"]): NativeTaskSpec {
	return { name: TASK_NAME, task: TASK_DESCRIPTION, proof, regression };
}

describe("ExtensionContext.task native host dispatch", () => {
	test(
		"returns a real native job before proof settles, attaches by stable name, and never calls the model",
		async () => {
			const gate = Promise.withResolvers<boolean>();
			const checked = Promise.withResolvers<void>();
			const observed: string[] = [];
			let first: NativeTaskResult | undefined;
			let attached: NativeTaskResult | undefined;
			const request = spec(
				async () => {
					observed.push("proof");
					checked.resolve();
					return gate.promise;
				},
				async () => {
					observed.push("regression");
					return true;
				},
			);
			const nativeSession = await createSession(pi => {
				pi.on("session_stop", async (_event, ctx) => {
					first = await ctx.task(request);
					attached = await ctx.task(request);
				});
			});
			const model = createMockModel({ handler: () => ({ content: ["Parent finished"] }) });
			nativeSession.agent.streamFn = model.stream;
			try {
				await nativeSession.extensionRunner!.emitSessionStop({
					awaiting_async_work: false,
					messages: [],
					turn_id: 0,
					session_id: nativeSession.sessionId,
					stop_hook_active: false,
					signal: new AbortController().signal,
				});
				await checked.promise;
				expect(first?.status).toBe("running");
				expect(first?.jobId).toBeTruthy();
				expect(first?.key).toContain(nativeSession.sessionId);
				expect(attached?.jobId).toBe(first?.jobId);
				expect(nativeSession.getAsyncJobSnapshot()?.running).toHaveLength(1);
				expect(nativeSession.nativeTaskHold?.status).toBe("running");
				expect(observed).toEqual(["proof"]);
				expect(model.calls).toHaveLength(0);
			} finally {
				gate.resolve(true);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"holds the parent after session_stop and rechecks completion without a second model turn",
		async () => {
			const gate = Promise.withResolvers<boolean>();
			const registered = Promise.withResolvers<void>();
			const rechecked = Promise.withResolvers<void>();
			const ended = Promise.withResolvers<void>();
			let stops = 0;
			const request = spec(
				async () => gate.promise,
				async () => true,
			);
			const nativeSession = await createSession(pi => {
				pi.on("session_stop", async (_event, ctx) => {
					stops++;
					const result = await ctx.task({ ...request });
					if (stops === 1) registered.resolve();
					else {
						expect(result.status).toBe("completed");
						rechecked.resolve();
					}
				});
			});
			const model = createMockModel({ handler: () => ({ content: ["Parent finished"] }) });
			nativeSession.agent.streamFn = model.stream;
			const unsubscribe = nativeSession.subscribe(event => {
				if (event.type === "agent_end") ended.resolve();
			});
			const prompt = nativeSession.prompt("Run the parent once");
			try {
				await registered.promise;
				expect(nativeSession.nativeTaskHold?.status).toBe("running");
				expect(nativeSession.isRunActive).toBe(true);
				gate.resolve(true);
				await rechecked.promise;
				await ended.promise;
				await prompt;
				expect(stops).toBe(2);
				expect(model.calls).toHaveLength(1);
				expect(nativeSession.nativeTaskHold).toBeUndefined();
			} finally {
				gate.resolve(true);
				unsubscribe();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"keeps a concrete unavailable proof blocker without regression or automatic respawn",
		async () => {
			let proofCalls = 0;
			let regressionCalls = 0;
			const request = spec(
				async () => {
					proofCalls++;
					throw new Error(CHECK_FAILURE);
				},
				async () => {
					regressionCalls++;
					return true;
				},
			);
			const nativeSession = await createSession(() => {});
			const blocked = Promise.withResolvers<void>();
			const unsubscribe = nativeSession.subscribe(event => {
				if (event.type === "notice" && event.message.includes(CHECK_FAILURE)) blocked.resolve();
			});
			try {
				const running = await nativeSession.extensionRunner!.createContext().task(request);
				await blocked.promise;
				const result = await nativeSession.task({ ...request }, { refresh: false });
				expect(result.status).toBe("blocked");
				expect(result.blocker).toContain(CHECK_FAILURE);
				expect(result.jobId).toBe(running.jobId);
				expect(nativeSession.nativeTaskHold?.status).toBe("blocked");
				expect(regressionCalls).toBe(0);
				expect(proofCalls).toBe(1);
			} finally {
				unsubscribe();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"resumes the parent on native verification failure before allowing completion",
		async () => {
			const resumed = Promise.withResolvers<void>();
			let successfulRegressions = 0;
			let repaired = false;
			let turns = 0;
			const request = spec(
				async () => {
					if (!repaired) throw new Error(CHECK_FAILURE);
					return true;
				},
				async () => {
					successfulRegressions++;
					return repaired;
				},
			);
			const nativeSession = await createSession(pi => {
				pi.on("session_stop", async (_event, ctx) => {
					if (!repaired) await ctx.task(request);
				});
			});
			const model = createMockModel({
				handler: () => {
					if (++turns === 2) {
						repaired = true;
						resumed.resolve();
					}
					return { content: [repaired ? "Repaired" : "Parent finished"] };
				},
			});
			nativeSession.agent.streamFn = model.stream;
			let ended = false;
			const completed = Promise.withResolvers<void>();
			const unsubscribe = nativeSession.subscribe(event => {
				if (event.type === "agent_end") {
					ended = true;
					completed.resolve();
				}
			});
			const prompt = nativeSession.prompt("Run the parent once");
			try {
				await resumed.promise;
				expect(ended).toBe(false);
				await prompt;
				await completed.promise;
				expect(model.calls).toHaveLength(2);
				expect(JSON.stringify(model.calls[1])).toContain(CHECK_FAILURE);
				expect(nativeSession.nativeTaskHold).toBeUndefined();
				expect(successfulRegressions).toBeGreaterThan(0);
			} finally {
				unsubscribe();
				await nativeSession.abort();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test("reports a missing native task tool instead of invoking a replacement or model", async () => {
		const nativeSession = await createSession(() => {}, ["read"]);
		const model = createMockModel({ handler: () => ({ content: ["Unexpected model invocation"] }) });
		nativeSession.agent.streamFn = model.stream;
		const result = await nativeSession.extensionRunner!.createContext().task({
			...spec(
				async () => true,
				async () => true,
			),
			name: BLOCKED_TASK_NAME,
		});
		expect(result.status).toBe("blocked");
		expect(result.blocker).toContain(`Native task tool unavailable for ${BLOCKED_TASK_NAME}`);
		expect(nativeSession.nativeTaskHold?.status).toBe("blocked");
		expect(model.calls).toHaveLength(0);
	});
});
