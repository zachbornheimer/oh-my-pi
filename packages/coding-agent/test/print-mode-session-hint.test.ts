/**
 * Regression: `omp -p` is the automation surface, so a run reports what a
 * caller needs to follow up without another discovery turn (ZYS-9697).
 *
 * Text mode never named the session on its output, so a follow-up needed a
 * separate lookup before `omp --resume <id>` could be used; and a final turn
 * that carried no answer text exited 0 with an empty stdout, indistinguishable
 * from a silent success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const SESSION_ID = "01a1eb4a-d946-73d1-b717-6ba919fe0a69";
const SESSION_FILE = "/tmp/sessions/2026-11-17_01a1eb4a-d946-73d1-b717-6ba919fe0a69.jsonl";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

/** Minimal mock of AgentSession, with a persisted session identity. */
function createMockSession(messages: AssistantMessage[]): AgentSession {
	return {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		settings: Settings.isolated(),
		sessionManager: {
			getHeader: () => undefined,
			getSessionId: () => SESSION_ID,
			getSessionFile: () => SESSION_FILE,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		waitForIdle: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("print mode follow-up hint", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the session so a follow-up resume needs no discovery", async () => {
		const session = createMockSession([makeAssistantMessage({ content: [{ type: "text", text: "the answer" }] })]);

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "ask" });

		expect(exitCode).toBe(0);
		expect(stdoutOutput.join("")).toContain("the answer");
		expect(stderrOutput.join("")).toContain(`Session: ${SESSION_ID}`);
		expect(stderrOutput.join("")).toContain(`omp --resume ${SESSION_ID}`);
	});

	it("reports an empty answer with its stop reason and transcript instead of exiting silently", async () => {
		const session = createMockSession([
			makeAssistantMessage({
				content: [{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "doc.md" } }],
				stopReason: "toolUse",
			}),
		]);

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "write the doc" });

		expect(exitCode).toBe(0);
		expect(stdoutOutput.join("")).toBe("");
		const stderr = stderrOutput.join("");
		expect(stderr).toContain("No answer text: the final assistant message carried no text (stop reason: toolUse).");
		expect(stderr).toContain(`Transcript: ${SESSION_FILE}`);
	});

	it("stays out of the JSON event stream", async () => {
		const session = createMockSession([makeAssistantMessage({ content: [{ type: "text", text: "the answer" }] })]);

		await runPrintMode(session, { mode: "json", initialMessage: "ask" });

		expect(stderrOutput.join("")).not.toContain("Session:");
	});
});
