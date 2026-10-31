import { describe, expect, it, vi } from "bun:test";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionShakeOptions,
} from "../src/extensibility/extensions/types";
import { normalizeExtensionShakeCall, type ShakeResult } from "../src/session/shake-types";

describe("normalizeExtensionShakeCall", () => {
	it("defaults to mode elide with requireArtifact: true when called without arguments", () => {
		const normalized = normalizeExtensionShakeCall();
		expect(normalized).toEqual({
			mode: "elide",
			options: { requireArtifact: true },
		});
	});

	it("preserves explicit mode and options", () => {
		const signal = new AbortController().signal;
		const options: ExtensionShakeOptions = {
			toolResultsOnly: true,
			requireArtifact: false,
			signal,
		};
		const normalized = normalizeExtensionShakeCall("images", options);
		expect(normalized).toEqual({
			mode: "images",
			options: {
				toolResultsOnly: true,
				requireArtifact: false,
				signal,
			},
		});
	});

	it("interprets options as first argument when mode is omitted", () => {
		const normalized = normalizeExtensionShakeCall({ toolResultsOnly: true });
		expect(normalized).toEqual({
			mode: "elide",
			options: {
				toolResultsOnly: true,
				requireArtifact: true,
			},
		});
	});

	it("preserves explicit requireArtifact: false when options is first argument", () => {
		const normalized = normalizeExtensionShakeCall({ requireArtifact: false });
		expect(normalized).toEqual({
			mode: "elide",
			options: {
				requireArtifact: false,
			},
		});
	});
});

describe("ExtensionRunner ctx.shake", () => {
	function createTestRunner(extensions: Extension[] = []) {
		return new ExtensionRunner(
			extensions,
			new ExtensionRuntime(),
			"/test",
			{ getCwd: () => "/test" } as never,
			{} as never,
		);
	}

	it("throws if called before runner is initialized", async () => {
		const runner = createTestRunner();
		const ctx = runner.createContext();
		await expect(ctx.shake()).rejects.toThrow("Session shake is not initialized");
	});

	it("forwards dual-signature ctx.shake(mode, options) to host shake", async () => {
		const runner = createTestRunner();
		const mockResult: ShakeResult = {
			mode: "elide",
			toolResultsDropped: 2,
			blocksDropped: 1,
			tokensFreed: 500,
			artifactId: "artifact-123",
		};
		const shakeSpy = vi.fn().mockResolvedValue(mockResult);
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			shake: shakeSpy,
			getSystemPrompt: () => [],
		};

		runner.initialize({} as never, contextActions);
		const ctx = runner.createContext();

		const result = await ctx.shake("elide", { toolResultsOnly: true, requireArtifact: true });
		expect(result).toBe(mockResult);
		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(shakeSpy).toHaveBeenCalledWith("elide", {
			toolResultsOnly: true,
			requireArtifact: true,
		});
	});

	it("forwards single-signature ctx.shake(options) defaulting to elide", async () => {
		const runner = createTestRunner();
		const mockResult: ShakeResult = {
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 200,
		};
		const shakeSpy = vi.fn().mockResolvedValue(mockResult);
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			shake: shakeSpy,
			getSystemPrompt: () => [],
		};

		runner.initialize({} as never, contextActions);
		const ctx = runner.createContext();

		const result = await ctx.shake({ toolResultsOnly: true });
		expect(result).toBe(mockResult);
		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(shakeSpy).toHaveBeenCalledWith("elide", {
			toolResultsOnly: true,
			requireArtifact: true,
		});
	});

	it("forwards mode thinking and images through ctx.shake(mode)", async () => {
		const runner = createTestRunner();
		const mockThinkingResult: ShakeResult = {
			mode: "thinking",
			toolResultsDropped: 0,
			blocksDropped: 0,
			thinkingBlocksDropped: 4,
			tokensFreed: 1200,
		};
		const shakeSpy = vi.fn().mockResolvedValue(mockThinkingResult);
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			shake: shakeSpy,
			getSystemPrompt: () => [],
		};

		runner.initialize({} as never, contextActions);
		const ctx = runner.createContext();

		const result = await ctx.shake("thinking");
		expect(result).toBe(mockThinkingResult);
		expect(shakeSpy).toHaveBeenCalledWith("thinking", {});
	});

	it("composes handler cancellation and awaits shake maintenance in event handlers", async () => {
		let shakeCompleted = false;
		let receivedSignal: AbortSignal | undefined;
		const mockResult: ShakeResult = {
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 100,
		};
		const shakeSpy = vi.fn().mockImplementation(async (_mode, options?: ExtensionShakeOptions) => {
			receivedSignal = options?.signal;
			const { promise, resolve } = Promise.withResolvers<void>();
			queueMicrotask(() => {
				shakeCompleted = true;
				resolve();
			});
			await promise;
			return mockResult;
		});

		const extension: Extension = {
			path: "/test/test-ext.ts",
			resolvedPath: "/test/test-ext.ts",
			handlers: new Map([
				[
					"session_start",
					[
						async (_event: unknown, ctx: unknown) => {
							const callerAbort = new AbortController();
							const res = await (ctx as ExtensionContext).shake({ signal: callerAbort.signal });
							expect(res).toBe(mockResult);
						},
					],
				],
			]),
			tools: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [],
			linkSchemes: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			shake: shakeSpy,
			getSystemPrompt: () => [],
		};
		const runner = createTestRunner([extension]);
		runner.initialize({} as never, contextActions);
		await runner.emit({ type: "session_start" });

		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(shakeCompleted).toBe(true);
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);
	});
});
