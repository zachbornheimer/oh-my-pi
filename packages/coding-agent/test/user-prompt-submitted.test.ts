import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionFactory, UserPromptSubmittedEvent } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(factory: ExtensionFactory, continuationModes: string[] = []) {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	cleanups.push(() => auth.close());
	const registry = new ModelRegistry(auth);
	const manager = SessionManager.inMemory(process.cwd());
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, process.cwd(), new EventBus(), runtime, "submission-test");
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, registry);
	const provider = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: provider.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		modelRegistry: registry,
		extensionRunner: runner,
		settings: Settings.isolated({ "compaction.enabled": false, "goal.continuationModes": continuationModes }),
	});
	cleanups.push(() => session.dispose());
	await initializeExtensions(session, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
	});
	return { session, runner, provider };
}

describe("real user submission lifecycle", () => {
	test("startup, print, composer and RPC enter one hook before agent preparation, with distinct identities for identical text", async () => {
		const events: UserPromptSubmittedEvent[] = [];
		const order: string[] = [];
		const delivered: string[] = [];
		const { session } = await fixture(pi => {
			pi.on("user_prompt_submitted", event => {
				events.push(event);
				order.push("submitted");
			});
			pi.on("before_agent_start", () => {
				order.push("prepare");
			});
			pi.on("user_prompt_delivered", event => {
				delivered.push(event.requestId);
				order.push("delivered");
			});
		});
		for (const source of ["cli", "print", "interactive", "rpc"] as const) {
			await session.submitUserPrompt("same text", { source, transport: source === "interactive" ? "tui" : source });
		}
		expect(events.map(event => event.source)).toEqual(["cli", "print", "interactive", "rpc"]);
		expect(new Set(events.map(event => event.requestId)).size).toBe(4);
		expect(events.every(event => event.sessionId === session.sessionId)).toBe(true);
		expect(delivered).toEqual(events.map(event => event.requestId));
		expect(order).toEqual(Array.from({ length: 4 }, () => ["submitted", "prepare", "delivered"]).flat());
	});

	test("queued identical requests deliver distinct identities and restoring one cancels only that identity", async () => {
		const submitted: string[] = [];
		const delivered: string[] = [];
		const dropped: string[] = [];
		const { session } = await fixture(pi => {
			pi.on("user_prompt_submitted", event => {
				submitted.push(event.requestId);
			});
			pi.on("user_prompt_delivered", event => {
				delivered.push(event.requestId);
			});
			pi.on("user_prompt_dropped", event => {
				dropped.push(event.requestId);
			});
		});
		const first = await session.captureUserPrompt("same", { source: "interactive", transport: "tui" });
		const second = await session.captureUserPrompt("same", { source: "interactive", transport: "tui" });
		if (!first || !second) throw new Error("capture rejected queued test input");
		session.cancelUserPrompt(first.requestId);
		await session.prompt(second.text, { submissionRequestId: second.requestId });
		expect(submitted).toEqual([first.requestId, second.requestId]);
		expect(dropped).toEqual([first.requestId]);
		expect(delivered).toEqual([second.requestId]);
	});

	test("queued requests notify delivery only when consumed and withdrawal cancels the exact duplicate", async () => {
		const submitted: string[] = [];
		const delivered: string[] = [];
		const dropped: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, provider } = await fixture(pi => {
			pi.on("user_prompt_submitted", event => {
				submitted.push(event.requestId);
			});
			pi.on("user_prompt_delivered", event => {
				delivered.push(event.requestId);
			});
			pi.on("user_prompt_dropped", event => {
				dropped.push(event.requestId);
			});
		});
		provider.fallback = async () => {
			entered.resolve();
			await release.promise;
			return { content: ["done"] };
		};
		const source = session.submitUserPrompt("source", { source: "print", transport: "cli" });
		await entered.promise;
		try {
			await session.submitUserPrompt("duplicate", {
				source: "rpc",
				transport: "rpc",
				streamingBehavior: "followUp",
			});
			await session.submitUserPrompt("duplicate", {
				source: "rpc",
				transport: "rpc",
				streamingBehavior: "followUp",
			});
			expect(delivered).toEqual([submitted[0]!]);
			expect(session.popLastQueuedMessage()?.text).toBe("duplicate");
			expect(dropped).toEqual([submitted[2]!]);
		} finally {
			release.resolve();
		}
		await source;
		await session.waitForIdle();
		expect(delivered).toEqual([submitted[0]!, submitted[1]!]);
	});

	test("headless unfinished goals stop on empty continuation activity", async () => {
		const { session } = await fixture(() => {}, ["print"]);
		await session.prompt("source");
		await session.goalRuntime.createGoal({ objective: "unmet" });
		await expect(session.runHeadlessUserInputWork()).rejects.toThrow("without progress");
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});

	test("headless continuation runs an unfinished goal to completion without creating another submission", async () => {
		const submitted: string[] = [];
		const { session, provider } = await fixture(
			pi => {
				pi.on("user_prompt_submitted", event => {
					submitted.push(event.requestId);
				});
			},
			["print"],
		);
		await session.submitUserPrompt("source", { source: "print", transport: "cli" });
		await session.goalRuntime.createGoal({ objective: "finish the source" });
		provider.fallback = async () => {
			await session.goalRuntime.completeGoalFromTool();
			return { content: ["complete"] };
		};
		await session.runHeadlessUserInputWork();
		expect(provider.calls).toHaveLength(2);
		expect(submitted).toHaveLength(1);
		expect(session.getGoalModeState()).toBeUndefined();
	});
	test("internal extension sends and synthetic prompts never create user submissions", async () => {
		const events: UserPromptSubmittedEvent[] = [];
		const { session } = await fixture(pi => {
			pi.on("user_prompt_submitted", event => {
				events.push(event);
			});
		});
		await session.sendUserMessage("internal extension message");
		await session.prompt("synthetic", { synthetic: true });
		expect(events).toEqual([]);
	});

	test("transforms chain without losing attachment identity and handled input never admits a turn", async () => {
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const seen: string[] = [];
		const { session, provider } = await fixture(pi => {
			pi.on("user_prompt_submitted", event => {
				expect(event.images?.[0]).toBe(image);
				seen.push(event.text);
				return { text: "changed" };
			});
			pi.on("user_prompt_submitted", event => {
				seen.push(event.text);
				return { handled: true };
			});
			pi.on("user_prompt_submitted", () => {
				seen.push("must not run");
			});
		});
		let admitted = false;
		const forwarded = await session.submitUserPrompt("original", {
			source: "print",
			transport: "cli",
			images: [image],
			onPromptAdmitted: () => {
				admitted = true;
			},
		});
		expect(forwarded).toBe(false);
		expect(seen).toEqual(["original", "changed"]);
		expect(admitted).toBe(false);
		expect(provider.calls).toHaveLength(0);
	});

	test("lifecycle work is separate from agent idle and drains work registered by work", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let finished = false;
		const { session } = await fixture(pi => {
			pi.on("user_prompt_submitted", (_event, ctx) => {
				ctx.waitUntil(
					first.promise.then(() => {
						ctx.waitUntil(
							second.promise.then(() => {
								finished = true;
							}),
						);
						reached.resolve();
					}),
				);
			});
		});
		await session.submitUserPrompt("work", { source: "print", transport: "cli" });
		await session.waitForIdle();
		expect(finished).toBe(false);
		const drained = session.waitForUserInputWork();
		first.resolve();
		await reached.promise;
		expect(finished).toBe(false);
		second.resolve();
		await drained;
		expect(finished).toBe(true);
	});
});
