/**
 * `omp -p '/force <tool> ...'` must behave like `/force` typed into an open session:
 * the `input` extension hook runs (so a model that cannot hard-force a tool gets the
 * rewritten instruction) and the run fails unless the model really called the tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

/** A session whose one model turn calls `calls` (name + arguments each), then ends. */
function createSession(inputResult: unknown, calls: ToolCallBlock[]) {
	let listener: ((event: unknown) => void) | undefined;
	const emitInput = vi.fn(async () => inputResult);
	const prompt = vi.fn(async () => {
		listener?.({
			type: "turn_end",
			message: { role: "assistant", content: calls },
			toolResults: calls.map(call => ({ toolName: call.name })),
		});
	});
	const session = {
		state: { messages: [] },
		getLastAssistantMessage: () => undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getCwd: () => "/tmp",
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		extensionRunner: {
			hasHandlers: () => true,
			emitInput,
			initialize: () => {},
			onError: () => {},
			emit: async () => undefined,
		},
		isStreaming: false,
		subscribe: (fn: (event: unknown) => void) => {
			listener = fn;
			return () => {};
		},
		prompt,
		waitForIdle: async () => {},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	return { session, prompt, emitInput };
}

const REWRITTEN = { text: "Call the `checksum` tool once now ...", forcedTool: "checksum" };

describe("print-mode /force through the input hook", () => {
	let stderr: string[];
	beforeEach(() => {
		stderr = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
	});
	afterEach(() => vi.restoreAllMocks());

	it("prompts the rewritten text and fails when the forced tool was never called", async () => {
		const { session, prompt, emitInput } = createSession(REWRITTEN, [
			{ type: "toolCall", name: "read", arguments: {} },
		]);

		const exitCode = await runPrintMode(session, { mode: "text", messages: ["/force checksum hi"] });

		expect(emitInput).toHaveBeenCalledWith("/force checksum hi", undefined, "cli");
		expect(prompt).toHaveBeenCalledWith(REWRITTEN.text);
		expect(exitCode).toBe(1);
		expect(stderr.join("")).toContain("/force checksum: the model did not call it this turn (called: read)");
	});

	it("passes when the model called the forced tool directly", async () => {
		const { session } = createSession(REWRITTEN, [{ type: "toolCall", name: "checksum", arguments: {} }]);

		expect(await runPrintMode(session, { mode: "text", messages: ["/force checksum hi"] })).toBe(0);
	});

	it("passes when the model reached the forced tool through the gateway's tool_call", async () => {
		const { session } = createSession(REWRITTEN, [
			{ type: "toolCall", name: "tool_call", arguments: { address: "omp/checksum" } },
		]);

		expect(await runPrintMode(session, { mode: "text", messages: ["/force checksum hi"] })).toBe(0);
	});

	it("never offers piped stdin to the input hook", async () => {
		const { session, prompt, emitInput } = createSession(REWRITTEN, []);

		await runPrintMode(session, { mode: "text", initialMessage: "/force checksum hi", messages: [] });

		expect(emitInput).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("/force checksum hi");
	});
});
