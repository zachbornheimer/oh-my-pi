/**
 * A user interrupt (Esc) ends the turn immediately: the agent loop stops
 * waiting for an in-flight tool that ignores its abort signal, the turn ends
 * without another provider request, and `AgentSession.abort` does not block
 * on foreign teardown work while the abandoned tool is still pending.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

let sharedAuthStorage: AuthStorage;
let sharedModelRegistry: ModelRegistry;
let sharedDir: string;

beforeAll(async () => {
	sharedDir = path.join(os.tmpdir(), `pi-hard-abort-shared-${Snowflake.next()}`);
	fs.mkdirSync(sharedDir, { recursive: true });
	sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
	sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
});

afterAll(() => {
	sharedAuthStorage.close();
	removeSyncWithRetries(sharedDir);
});

/** Race `work` against a bounded timer backstop; the caller asserts which won. */
async function raceBounded<T>(work: Promise<T>, boundMs: number): Promise<{ work: T } | { timer: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then((value): { work: T } => ({ work: value })),
			new Promise<{ timer: true }>(resolve => {
				timer = setTimeout(() => resolve({ timer: true }), boundMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("AgentSession instant hard abort", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-hard-abort-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	it("ends a user interrupt without waiting for a never-settling tool", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const started = Promise.withResolvers<void>();
		const never = Promise.withResolvers<string>();
		// Ignores its abort signal and never settles until the test releases it.
		const hangingTool: AgentTool = {
			name: "hanging_tool",
			label: "Hanging Tool",
			description: "Waits until the test releases it",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				const value = await never.promise;
				return { content: [{ type: "text" as const, text: value }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-hang", name: "hanging_tool", arguments: {} }] },
				{ content: ["second turn done"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [hangingTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});

		const firstPrompt = session.prompt("Run the hanging tool");
		void firstPrompt.catch(() => {});
		await started.promise;

		// (a) The interrupt settles promptly while the tool is still pending;
		// the bounded timer backstop must not win.
		const outcome = await raceBounded(session.abort({ reason: USER_INTERRUPT_LABEL }), 2_000);
		expect("timer" in outcome).toBe(false);

		// (b) The session is immediately revivable.
		expect(session.isStreaming).toBe(false);

		// (c) A second prompt starts right away and completes against the
		// scripted model — no extra provider round trip for the aborted turn.
		await session.prompt("Follow up");
		expect(mock.calls).toHaveLength(2);
		const messages: AgentMessage[] = agent.state.messages;
		const lastAssistant = messages.findLast(
			(message): message is Extract<AgentMessage, { role: "assistant" }> =>
				message.role === "assistant" && message.stopReason === "stop",
		);
		const finishedWithSecondTurn = lastAssistant?.content.some(
			(block: { type: string; text?: string }): boolean =>
				block.type === "text" && block.text === "second turn done",
		);
		expect(finishedWithSecondTurn).toBe(true);

		// (d) The abandoned call still received an aborted toolResult message,
		// so tool_call/tool_result pairing holds.
		const toolResult = messages.find(message => message.role === "toolResult" && message.toolCallId === "call-hang");
		expect(toolResult).toBeDefined();
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("Expected a toolResult message");
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content.some(block => block.type === "text" && block.text.includes("aborted"))).toBe(true);
		const abortedAssistant = messages.find(
			message => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(abortedAssistant).toBeDefined();

		// Release the abandoned tool so nothing dangles into dispose.
		never.resolve("late");
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		await firstPrompt;
	});
});
