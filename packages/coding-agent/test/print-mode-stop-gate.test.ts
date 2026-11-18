/**
 * Print mode is a single-answer channel: its stdout contract is the turn that
 * answered the prompt. A `session_stop` handler that asks for a hidden
 * continuation must not append a turn after that answer (ZYS-9719 — the gate
 * turn became `omp -p` stdout while the real answer never printed), and the
 * suppressed pass is reported on stderr with the command that resumes the
 * session where the stop gate does run.
 */
import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

function captureOutput() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const collect = (sink: string[]) => (...args: unknown[]) => {
		if (typeof args[0] === "string") sink.push(args[0]);
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	};
	vi.spyOn(process.stdout, "write").mockImplementation(collect(stdout));
	vi.spyOn(process.stderr, "write").mockImplementation(collect(stderr));
	return { stdout, stderr };
}

/** Partial ExtensionRunner double: only the surfaces the stop path touches. */
function stopGateRunner(stopPasses: { count: number }) {
	return {
		initialize: vi.fn(),
		onError: vi.fn(),
		emit: vi.fn(() => Promise.resolve(undefined)),
		emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
		hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
		emitSessionStop: vi.fn(() => {
			stopPasses.count++;
			return Promise.resolve({ continue: true, additionalContext: "Add the review block." });
		}),
	} as unknown as ExtensionRunner;
}

/**
 * The prompt's answer comes first; every continuation turn the stop gate schedules
 * gets "GATE TURN", so a displaced answer is visible on stdout instead of a mock
 * exhaustion error.
 */
function answerThenGateTurns() {
	return {
		responses: [{ content: ["ANSWER"] }],
		handler: () => ({ content: ["GATE TURN"] }),
	};
}

async function printModeSession(dir: TempDir, stopPasses: { count: number }) {
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const model = createMockModel(answerThenGateTurns());
	auth.keys.setRuntime(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model.stream,
		}),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
		extensionRunner: stopGateRunner(stopPasses),
	});
	return { auth, model, session };
}

it("ends text mode at the answering turn instead of continuing a session_stop handler", async () => {
	const dir = TempDir.createSync("@pi-print-stop-gate-");
	const { stdout, stderr } = captureOutput();
	const stopPasses = { count: 0 };
	const { auth, model, session } = await printModeSession(dir, stopPasses);
	try {
		const code = await runPrintMode(session, { mode: "text", initialMessage: "Reply with ANSWER" });
		expect(code).toBe(0);
		expect(stdout.join("")).toBe("ANSWER\n");
		expect(model.calls).toHaveLength(1);
		// The pass is skipped, not emitted and ignored: the handler never runs.
		expect(stopPasses.count).toBe(0);
		const err = stderr.join("");
		expect(err).toContain(session.sessionId);
		expect(err).toContain(`--resume ${session.sessionId}`);
	} finally {
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});

it("keeps emitting every assistant message in json mode after a suppressed stop pass", async () => {
	const dir = TempDir.createSync("@pi-print-stop-gate-json-");
	const { stdout } = captureOutput();
	const stopPasses = { count: 0 };
	const { auth, model, session } = await printModeSession(dir, stopPasses);
	try {
		const code = await runPrintMode(session, { mode: "json", initialMessage: "Reply with ANSWER" });
		expect(code).toBe(0);
		const records = stdout
			.join("")
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } });
		const assistantEnds = records.filter(
			record => record.type === "message_end" && record.message?.role === "assistant",
		);
		// The stream stays the full record of the session's assistant turns: one
		// message_end per model round, none filtered out or duplicated.
		expect(assistantEnds).toHaveLength(model.calls.length);
		expect(JSON.stringify(assistantEnds[0]?.message?.content)).toContain("ANSWER");
		expect(stopPasses.count).toBe(0);
	} finally {
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});
