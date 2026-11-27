import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { convertToLlm } from "./messages";
import { SessionManager } from "./session-manager";

function makeSession(blockRebuild?: () => Promise<void>) {
	const tools: AgentTool[] = ["read", "goal", "bash"].map(name => ({
		name, label: name, description: name, parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }] }),
	}));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), systemPrompt: [], tools: [tools[0]!] },
		convertToLlm,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true, "extensionHandlers.modeControl": true }),
		// No model call occurs in this lifecycle-only fixture.
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		builtInToolNames: tools.map(tool => tool.name),
		rebuildSystemPrompt: async () => {
			await blockRebuild?.();
			return { systemPrompt: [] };
		},
	});
}

test("session-owned goal contribution survives roster replacement and respects explicit goal selection", async () => {
	const session = makeSession();
	try {
		const modes = session.getHeadlessSessionModes();
		expect(await modes.set({ mode: "goal", action: "enter", objective: "work" })).toMatchObject({ ok: true });
		await session.setActiveToolsByName(["read", "bash"]);
		expect(session.getEnabledToolNames()).toContain("goal");
		await modes.set({ mode: "goal", action: "drop" });
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.getEnabledToolNames()).toContain("bash");
		await modes.set({ mode: "goal", action: "enter", objective: "next" });
		await session.setActiveToolsByName(["read", "goal"]);
		await modes.set({ mode: "goal", action: "drop" });
		expect(session.getEnabledToolNames()).toContain("goal");
	} finally { await session.dispose(); }
});

test("goal admission and context replacement share session transition exclusion", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let block = true;
	const session = makeSession(async () => {
		if (!block) return;
		started.resolve();
		await release.promise;
	});
	try {
		const modes = session.getHeadlessSessionModes();
		const entering = modes.set({ mode: "goal", action: "enter", objective: "work" });
		await started.promise;
		expect(session.isSessionTransitioning).toBe(true);
		expect(await modes.set({ mode: "goal", action: "pause" })).toMatchObject({ ok: false, code: "busy" });
		const reset = session.resetSessionContext();
		expect(session.isSessionTransitioning).toBe(true);
		block = false;
		release.resolve();
		expect(await entering).toMatchObject({ ok: true });
		await reset;
		expect(session.isSessionTransitioning).toBe(false);
	} finally { release.resolve(); await session.dispose(); }
});

test("session lifecycle drain settles terminal completion without adapter finalizer", async () => {
	const session = makeSession();
	try {
		const modes = session.getHeadlessSessionModes();
		await modes.set({ mode: "goal", action: "enter", objective: "work" });
		await session.goalRuntime.completeGoalFromTool();
		await session.runHeadlessUserInputWork();
		await session.runHeadlessUserInputWork();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "goal-completed")).toHaveLength(1);
	} finally { await session.dispose(); }
});
