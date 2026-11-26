import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Container } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

describe("/btw configured fallback", () => {
	it.each([false, true])("429 walks configured routes and leaves parent unchanged, resumed=%s", async resumed => {
		await scenario(resumed, "fallback", { fallback: true, error: false });
	});
	it("healthy primary renders without fallback", async () => {
		await scenario(true, "healthy", { fallback: false, error: false });
	});
	it("exhaustion reports one error and terminates cyclic chains", async () => {
		await scenario(true, "exhausted", { fallback: true, error: true });
	});

	it("does not replay a partially visible answer", async () => {
		await scenario(true, "partial", { fallback: false, error: true });
	});

	it("registered Gateway route uses model-aware credentials after resume", async () => {
		await scenario(true, "fallback", { fallback: true, error: false }, "gateway");
	});
	it.each(["disabled", "trigger", "offline", "cooldown", "credentials"] as const)(
		"honors %s eligibility",
		async policy => {
			await scenario(true, "blocked", { fallback: false, error: true }, policy);
		},
	);

	it("skips a fallback that cannot preserve the output cap", async () => {
		const dir = TempDir.createSync("omp-btw-cap-fallback-");
		await using resources = new AsyncDisposableStack();
		resources.defer(resetSettingsForTest);
		resources.defer(() => dir.removeSync());
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		resources.defer(() => auth.close());
		auth.keys.setRuntime("openai", "fixture");
		const registry = new ModelRegistry(auth);
		const primary = registry.find("openai", "gpt-4o-mini")!;
		registry.registerProvider("fixture", {
			api: "openai-responses",
			baseUrl: "https://fixture.invalid/v1",
			apiKey: "fixture",
			models: [
				{ ...primary, id: "uncapped", contextWindow: 128_000, maxTokens: 4096 },
				{ ...primary, id: "capped", contextWindow: 128_000, maxTokens: 4096 },
			],
		});
		registry.find("fixture", "uncapped")!.omitMaxOutputTokens = true;
		const attempts: string[] = [];
		const mock = createMockModel();
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: primary, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.modelFallback": true,
				"retry.fallbackChains": { "openai/gpt-4o-mini": ["fixture/uncapped", "fixture/capped"] },
			}),
			modelRegistry: registry,
			sideStreamFn: async (model, context, options) => {
				attempts.push(`${model.provider}/${model.id}`);
				expect(options?.maxTokens).toBe(64);
				mock.push(model === primary ? { throw: new Error("429 rate limit exceeded") } : { content: ["Answer"] });
				return mock.stream(model, context, options);
			},
		});
		resources.defer(() => session.dispose());
		const result = await session.runEphemeralTurn({ promptText: "Question", maxTokens: 64 });
		expect(result.replyText).toBe("Answer");
		expect(attempts).toEqual(["openai/gpt-4o-mini", "fixture/capped"]);
		expect(session.model).toBe(primary);
	});
	async function scenario(
		resumed: boolean,
		result: "fallback" | "healthy" | "exhausted" | "blocked" | "partial",
		expected: { fallback: boolean; error: boolean },
		policy?: "gateway" | "disabled" | "trigger" | "offline" | "cooldown" | "credentials",
	) {
		const dir = TempDir.createSync("omp-btw-fallback-");
		await using resources = new AsyncDisposableStack();
		resources.defer(resetSettingsForTest);
		resources.defer(() => dir.removeSync());
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		resources.defer(() => auth.close());
		auth.keys.setRuntime("anthropic", "fixture-primary");
		auth.keys.setRuntime("openai", "fixture-fallback");
		const registry = new ModelRegistry(auth);
		const primary = registry.find("anthropic", "claude-sonnet-4-5")!;
		const base = registry.find("openai", "gpt-4o-mini")!;
		if (policy === "gateway")
			registry.registerProvider("gw", {
				api: "openai-responses",
				baseUrl: "https://gateway.invalid/v1",
				apiKey: "fixture-gateway",
				models: [{ ...base, id: "openai/gpt-4o-mini", contextWindow: 128_000, maxTokens: 4096 }],
			});
		const secondary = policy === "gateway" ? registry.find("gw", "openai/gpt-4o-mini")! : base;
		const primaryRoute = `${primary.provider}/${primary.id}`;
		const secondaryRoute = `${secondary.provider}/${secondary.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { [primaryRoute]: [secondaryRoute], [secondaryRoute]: [primaryRoute] },
			"retry.modelFallback": true,
			...(policy === "disabled" ? { "retry.modelFallback": false } : {}),
			...(policy === "trigger" ? { "retry.fallbackOn": "usage-limit" } : {}),
			...(policy === "offline" ? { "models.offline": true } : {}),
		});
		if (policy === "cooldown") registry.suppressSelector(secondaryRoute, Date.now() + 60_000);
		if (policy === "credentials") vi.spyOn(registry, "getApiKey").mockResolvedValue(undefined);
		let manager = SessionManager.create(dir.path(), dir.path());
		let session: AgentSession | undefined;
		resources.defer(() => (session ? session.dispose() : manager.close()));
		manager.appendModelChange(primaryRoute, "default");
		manager.appendMessage({ role: "user", content: "We were fixing the cache", timestamp: 1 });
		await manager.ensureOnDisk();
		if (resumed) {
			const file = manager.getSessionFile()!;
			await manager.close();
			manager = await SessionManager.open(file, dir.path());
		}
		const parentSessionId = manager.getSessionId();
		const attempts: string[] = [];
		const signals: AbortSignal[] = [];
		const mock = createMockModel();
		const sideStreamFn: StreamFn = async (model, context, options) => {
			attempts.push(`${model.provider}/${model.id}`);
			if (signals.length) expect(signals.at(-1)?.aborted).toBe(true);
			expect(options?.signal?.aborted).toBe(false);
			if (options?.signal) signals.push(options.signal);
			// Authentication stays model-aware and resolves in the parent's credential scope.
			expect(typeof options?.apiKey).toBe("function");
			const key =
				typeof options?.apiKey === "function"
					? await options.apiKey({ lastChance: false, error: undefined })
					: undefined;
			expect(typeof key === "string" ? key : key?.apiKey).toBe(
				model.provider === "anthropic"
					? "fixture-primary"
					: model.provider === "gw"
						? "fixture-gateway"
						: "fixture-fallback",
			);
			expect(options?.sessionId).not.toBe(parentSessionId);
			expect(options?.parentSessionId).toBe(parentSessionId);
			if (result === "partial") {
				mock.push({ content: ["Partial answer"], stopReason: "error", errorMessage: "429 rate limit exceeded" });
			} else if (result === "exhausted" || result === "blocked" || (result === "fallback" && model === primary)) {
				mock.push({ throw: new Error("429 rate_limit_error: rate limit exceeded") });
			} else mock.push({ content: ["We were fixing the cache."] });
			return mock.stream(model, context, options);
		};
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: primary,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			sideStreamFn,
		});
		const mode = new InteractiveMode(session, "test");
		resources.defer(() => mode.stop());
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		const controller = new BtwController(mode);
		resources.defer(() => controller.dispose());
		const settled = Promise.withResolvers<void>();
		const complete = vi
			.spyOn(BtwPanelComponent.prototype, "markComplete")
			.mockImplementation(() => settled.resolve());
		const failed = vi.spyOn(BtwPanelComponent.prototype, "markError").mockImplementation(() => settled.resolve());
		const answer = vi.spyOn(BtwPanelComponent.prototype, "setAnswer");
		const before = structuredClone(session.messages);
		const entries = structuredClone(manager.getEntries());
		expect(await controller.start("I stepped away. Where were we?")).toBe(true);
		await settled.promise;
		await controller.flush();
		expect(attempts).toEqual(expected.fallback ? [primaryRoute, secondaryRoute] : [primaryRoute]);
		if (expected.error) {
			expect(failed).toHaveBeenCalledTimes(1);
			expect(failed.mock.calls[0]?.[0]).toContain("No eligible fallback");
			expect(complete).not.toHaveBeenCalled();
		} else {
			expect(answer).toHaveBeenCalledWith("We were fixing the cache.");
			expect(complete).toHaveBeenCalledTimes(1);
			expect(failed).not.toHaveBeenCalled();
			const panel = (mode.btwContainer as Container).children[0]!;
			expect(panel.render(100).join("\n")).toContain("We were fixing the cache.");
		}
		expect(session.model).toBe(primary);
		expect(session.messages).toEqual(before);
		// Usage accounting may append completion entries; conversation/model entries stay unchanged.
		expect(manager.getEntries().filter(e => e.type !== "model_usage")).toEqual(
			entries.filter(e => e.type !== "model_usage"),
		);
	}
});
