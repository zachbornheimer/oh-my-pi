import { describe, expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { GoalRuntime } from "../goals/runtime";
import type { GoalModeState } from "../goals/state";
import { createHeadlessSessionModes } from "./headless-session-modes";
import { SessionGoalControl } from "./session-goal-control";
import type { SessionModeResult } from "../extensibility/extensions/types";

function host(control = true) {
	let state: GoalModeState | undefined;
	let tools = ["read"];
	let contributed = false;
	let selectedGoal = false;
	let transitioning = false;
	let busy = false;
	let failActivation = false;
	const entries: unknown[] = [];
	const runtime = new GoalRuntime({
		getState: () => state,
		setState: next => { state = next; },
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: () => {},
		persist: (mode, value) => { entries.push({ mode, value }); },
		sendHiddenMessage: async () => {},
	});
	const session = {
		settings: Settings.isolated({ "goal.enabled": true, "extensionHandlers.modeControl": control }),
		goalRuntime: runtime,
		sessionManager: {
			appendModeChange: (mode: string) => { entries.push({ mode }); },
			appendCustomEntry: (kind: string, value: unknown) => { entries.push({ kind, value }); },
		},
		get isBusyForSnapshot() { return busy; },
		get isSessionTransitioning() { return transitioning; },
		runGoalTransition: async (work: () => Promise<SessionModeResult>) => {
			transitioning = true;
			try { return await work(); } finally { transitioning = false; }
		},
		setGoalToolContribution: async (enabled: boolean) => {
			if (enabled === contributed) return;
			if (failActivation && enabled) throw new Error("activation failed");
			if (enabled) selectedGoal = tools.includes("goal");
			tools = enabled ? [...new Set([...tools, "goal"])] : selectedGoal ? tools : tools.filter(name => name !== "goal");
			contributed = enabled;
		},
		getGoalModeState: () => state,
		setGoalModeState: (next: GoalModeState | undefined) => { state = next; },
		getPlanModeState: () => undefined,
		getVibeModeState: () => undefined,
		getEnabledToolNames: () => tools,
		setActiveToolsByName: async (next: string[]) => {
			if (failActivation && next.includes("goal")) throw new Error("activation failed");
			tools = next;
		},
	};
	// The fixture supplies only the session lifecycle port exercised here.
	const owner = new SessionGoalControl(session);
	const modes = createHeadlessSessionModes(owner);
	return {
		modes, runtime, entries, session,
		state: () => state,
		tools: () => tools,
		busy: (value: boolean) => { busy = value; },
		fail: () => { failActivation = true; },
		finalize: () => owner.settle(),
	};
}

test("headless adapter forwards goal intent and never forwards unsupported modes", async () => {
	const h = host();
	const requests: unknown[] = [];
	const failure = new Error("owner failed");
	const modes = createHeadlessSessionModes({
		readState: () => h.modes.getState(),
		requestFromExtension: async request => { requests.push(request); throw failure; },
	});
	expect(await modes.set({ mode: "plan", action: "enter" })).toMatchObject({ ok: false, code: "invalid_request" });
	expect(requests).toEqual([]);
	const request = { mode: "goal", action: "enter", objective: "work" } as const;
	await expect(modes.set(request)).rejects.toBe(failure);
	expect(requests).toEqual([request]);
});

test("session owner preserves activation and compensation failures", async () => {
	const h = host();
	h.fail();
	const compensation = new Error("rollback failed");
	h.runtime.dropGoal = async () => { throw compensation; };
	try {
		await h.modes.set({ mode: "goal", action: "enter", objective: "work" });
		throw new Error("expected activation failure");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		if (!(error instanceof AggregateError)) throw error;
		expect(error.errors[0].message).toBe("activation failed");
		expect(error.errors[1]).toBe(compensation);
		expect(error.cause).toBe(error.errors[0]);
	}
});

test("completion persistence failure retains state for another lifecycle settlement", async () => {
	const h = host();
	await h.modes.set({ mode: "goal", action: "enter", objective: "work" });
	await h.runtime.completeGoalFromTool();
	const append = h.session.sessionManager.appendCustomEntry;
	h.session.sessionManager.appendCustomEntry = () => { throw new Error("journal unavailable"); };
	await expect(h.finalize()).rejects.toThrow("journal unavailable");
	expect(h.state()?.goal.status).toBe("complete");
	h.session.sessionManager.appendCustomEntry = append;
	await h.finalize();
	expect(h.state()).toBeUndefined();
});

describe("headless mode behavior contract", () => {
	test("normalizes objectives, preserves identity through pause/resume, and releases only added tools", async () => {
		const h = host();
		expect(await h.modes.set({ mode: "goal", action: "enter", objective: " work ", tokenBudget: 100 })).toMatchObject({ ok: true, changed: true });
		const id = h.state()?.goal.id;
		h.busy(true);
		expect(await h.modes.set({ mode: "goal", action: "enter", objective: "work", tokenBudget: 100 })).toMatchObject({ ok: true, changed: false });
		expect(await h.modes.set({ mode: "goal", action: "pause" })).toMatchObject({ ok: false, code: "busy" });
		h.busy(false);
		await h.modes.set({ mode: "goal", action: "pause" });
		await h.finalize();
		expect(h.state()?.goal.status).toBe("paused");
		expect(h.tools()).toEqual(["read"]);
		await h.modes.set({ mode: "goal", action: "resume" });
		expect(h.state()?.goal.id).toBe(id);
		h.tools().push("bash");
		await h.modes.set({ mode: "goal", action: "drop" });
		expect(h.tools()).toEqual(["read", "bash"]);
		expect(h.modes.getState().goal.status).toBe("inactive");
	});

	test("reports refusals without mutating state", async () => {
		const h = host();
		for (const request of [
			{ mode: "plan", action: "enter" },
			{ mode: "goal", action: "pause" },
			{ mode: "goal", action: "resume" },
			{ mode: "goal", action: "enter", objective: " " },
			{ mode: "goal", action: "enter", objective: "work", tokenBudget: 0 },
		] as const) expect(await h.modes.set(request)).toMatchObject({ ok: false, code: "invalid_request" });
		expect(h.entries).toEqual([]);
		expect(await host(false).modes.set({ mode: "goal", action: "enter", objective: "work" })).toMatchObject({ ok: false, code: "disabled" });
	});

	test("compensates activation failures and records terminal completion once", async () => {
		const failed = host();
		failed.fail();
		await expect(failed.modes.set({ mode: "goal", action: "enter", objective: "work" })).rejects.toThrow("activation failed");
		expect(failed.state()).toBeUndefined();
		const h = host();
		await h.modes.set({ mode: "goal", action: "enter", objective: "work" });
		await h.runtime.completeGoalFromTool();
		expect(await h.modes.set({ mode: "goal", action: "enter", objective: "next" })).toMatchObject({ ok: false, code: "busy" });
		await h.finalize();
		await h.finalize();
		expect(h.state()).toBeUndefined();
		expect(h.tools()).toEqual(["read"]);
		expect(h.entries.filter(entry => entry !== null && typeof entry === "object" && "kind" in entry && entry.kind === "goal-completed")).toHaveLength(1);
	});
});
