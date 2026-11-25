/**
 * A `session_stop` block must never end a run as success, however often the writer ignores it.
 * Drives a real AgentSession with a hook double that always blocks the same required work.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionStopEventResult, StopHandlerRun } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { STOP_OBLIGATIONS_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/stop-obligations";
import { TempDir } from "@oh-my-pi/pi-utils";

const HOOK = "/ext/review.ts";

describe("AgentSession stop obligations", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-stop-obligations-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		responses: number,
		hook: () => SessionStopEventResult | undefined,
		sessionManager = SessionManager.inMemory(),
	) {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");
		const mock = createMockModel({
			responses: Array.from({ length: responses }, (_, index) => ({
				content: [`writer reply ${index}`],
				stopReason: "stop" as const,
			})),
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		let stops = 0;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
			getRegisteredTool: () => undefined,
			emitSessionStop: async (_event: unknown, onHandlerRun?: (run: StopHandlerRun) => void) => {
				stops++;
				onHandlerRun?.({ issuer: HOOK });
				return hook();
			},
		} as unknown as ExtensionRunner;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		return { mock, stops: () => stops, sessionManager };
	}

	const refuse = (): SessionStopEventResult => ({
		decision: "block",
		reason: "rewrite ops.ts: required",
		issuer: HOOK,
		obligation: { id: "design-review", progress: "src-1" },
	});

	it("stops asking the writer after two ignored blocks and leaves the work pending, not complete", async () => {
		const { mock } = createSession(10, refuse);
		await session?.prompt("do the thing");
		await session?.waitForIdle();
		// Initial reply + two hook-forced continuations; then the host pauses instead of spinning or passing.
		expect(mock.calls).toHaveLength(3);
		expect(session?.stopObligations.map(record => [record.id, record.status])).toEqual([["design-review", "paused"]]);
	});

	it("persists the pending obligation in the session so a reload still owes it", async () => {
		const manager = SessionManager.inMemory();
		createSession(10, refuse, manager);
		await session?.prompt("do the thing");
		await session?.waitForIdle();
		const entry = manager
			.getBranch()
			.findLast(item => item.type === "custom" && item.customType === STOP_OBLIGATIONS_CUSTOM_TYPE);
		expect(entry).toBeDefined();
		const restored = new AgentSession({
			agent: session!.agent,
			sessionManager: manager,
			settings: session!.settings,
			modelRegistry,
		});
		try {
			expect(restored.stopObligations.map(record => record.status)).toEqual(["paused"]);
		} finally {
			await restored.dispose();
		}
	});

	it("is cleared only by the issuing hook's clean recheck", async () => {
		let blocking = true;
		const { mock } = createSession(10, () => (blocking ? refuse() : undefined));
		await session?.prompt("do the thing");
		await session?.waitForIdle();
		expect(session?.stopObligations).toHaveLength(1);
		blocking = false;
		await session?.prompt("try again");
		await session?.waitForIdle();
		expect(session?.stopObligations).toEqual([]);
		expect(mock.calls.length).toBeGreaterThan(3);
	});

	it("is cleared by an explicit user cancel and the issuer hears exactly what was waived", async () => {
		createSession(10, refuse);
		await session?.prompt("do the thing");
		await session?.waitForIdle();
		const removed = session?.cancelStopObligations({ id: "design-review" });
		expect(removed?.map(record => record.progress)).toEqual(["src-1"]);
		expect(session?.stopObligations).toEqual([]);
	});
});
