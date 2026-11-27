import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { GoalRuntime } from "../src/goals/runtime";
import type { GoalModeState } from "../src/goals/state";
import { createHeadlessSessionModes } from "../src/session/headless-session-modes";
import { SessionGoalControl } from "../src/session/session-goal-control";
import type { SessionModeResult } from "../src/extensibility/extensions/types";

function host(
	options: {
		tools?: string[];
		failActivation?: boolean;
		enabled?: boolean;
		control?: boolean;
	} = {},
) {
	let state: GoalModeState | undefined;
	let tools = options.tools ?? ["read"];
	let busy = false;
	let transitioning = false;
	let contributed = false;
	let goalSelected = false;
	let plan: { enabled: boolean; planFilePath: string } | undefined;
	const entries: unknown[] = [];
	const runtime = new GoalRuntime({
		getState: () => state,
		setState: (next) => {
			state = next;
		},
		getCurrentUsage: () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		}),
		emit: () => {},
		persist: (mode, value) => {
			entries.push({ mode, value });
		},
		sendHiddenMessage: async () => {},
	});
	const session = {
		settings: Settings.isolated({
			"goal.enabled": options.enabled ?? true,
			"extensionHandlers.modeControl": options.control ?? true,
		}),
		goalRuntime: runtime,
		sessionManager: {
			appendModeChange: (mode: string) => {
				entries.push({ mode });
			},
			appendCustomEntry: (kind: string, value: unknown) => {
				entries.push({ kind, value });
			},
		},
		get isBusyForSnapshot() {
			return busy;
		},
		get isSessionTransitioning() {
			return transitioning;
		},
		runGoalTransition: async (work: () => Promise<SessionModeResult>) => {
			transitioning = true;
			try {
				return await work();
			} finally {
				transitioning = false;
			}
		},
		setGoalToolContribution: async (enabled: boolean) => {
			if (enabled === contributed) return;
			if (options.failActivation && enabled) throw new Error("activation failed");
			if (enabled) goalSelected = tools.includes("goal");
			tools = enabled ? [...new Set([...tools, "goal"])] : goalSelected ? tools : tools.filter(name => name !== "goal");
			contributed = enabled;
		},
		getGoalModeState: () => state,
		setGoalModeState: (next: GoalModeState | undefined) => {
			state = next;
		},
		getPlanModeState: () => plan,
		getVibeModeState: () => undefined,
		getEnabledToolNames: () => tools,
		setActiveToolsByName: async (next: string[]) => {
			if (options.failActivation && next.includes("goal"))
				throw new Error("activation failed");
			tools = next;
		},
	};
	// The fixture implements the session lifecycle port; journal storage is not involved.
	const owner = new SessionGoalControl(session);
	const modes = createHeadlessSessionModes(owner);
	return {
		session,
		modes,
		owner,
		runtime,
		entries,
		tools: () => tools,
		state: () => state,
		setBusy: (value: boolean) => {
			busy = value;
		},
		setTransitioning: (value: boolean) => {
			transitioning = value;
		},
		setPlan: () => {
			plan = { enabled: true, planFilePath: "/tmp/plan.md" };
		},
		addTool: (name: string) => {
			tools.push(name);
		},
	};
}

describe("headless goal control", () => {
	test("enters, pauses, resumes with accounting intact, and drops", async () => {
		const h = host();
		expect(
			await h.modes.set({
				mode: "goal",
				action: "enter",
				objective: "Report startup cause",
				tokenBudget: 1000,
			}),
		).toMatchObject({ ok: true, changed: true });
		const id = h.state()?.goal.id;
		expect(h.tools()).toEqual(["read", "goal"]);
		expect(
			await h.modes.set({
				mode: "goal",
				action: "enter",
				objective: "Report startup cause",
				tokenBudget: 1000,
			}),
		).toMatchObject({ ok: true, changed: false });
		await h.modes.set({ mode: "goal", action: "pause" });
		expect(h.modes.getState().goal.status).toBe("paused");
		expect(h.tools()).toEqual(["read"]);
		await h.modes.set({ mode: "goal", action: "resume" });
		expect(h.state()?.goal.id).toBe(id);
		expect(h.tools()).toContain("goal");
		await h.modes.set({ mode: "goal", action: "drop" });
		expect(h.modes.getState().goal.status).toBe("inactive");
		expect(h.state()).toBeUndefined();
		expect(h.tools()).toEqual(["read"]);
	});

	test("refuses disabled, conflicting, busy, and malformed transitions without effects", async () => {
		expect(
			await host({ control: false }).modes.set({
				mode: "goal",
				action: "enter",
				objective: "work",
			}),
		).toMatchObject({ ok: false, code: "disabled" });
		expect(
			await host({ enabled: false }).modes.set({
				mode: "goal",
				action: "enter",
				objective: "work",
			}),
		).toMatchObject({ ok: false, code: "disabled" });
		const h = host();
		h.setBusy(true);
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: "work" }),
		).toMatchObject({ ok: false, code: "busy" });
		h.setBusy(false);
		h.setTransitioning(true);
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: "work" }),
		).toMatchObject({ ok: false, code: "busy" });
		h.setTransitioning(false);
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: " " }),
		).toMatchObject({ ok: false, code: "invalid_request" });
		expect(
			await h.modes.set({
				mode: "goal",
				action: "enter",
				objective: "work",
				tokenBudget: 0,
			}),
		).toMatchObject({ ok: false, code: "invalid_request" });
		h.setPlan();
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: "work" }),
		).toMatchObject({ ok: false, code: "conflict" });
		expect(h.entries).toEqual([]);
	});

	test("preserves tools enabled after entry and preexisting goal tools", async () => {
		for (const preexisting of [false, true]) {
			const h = host({ tools: preexisting ? ["read", "goal"] : ["read"] });
			await h.modes.set({ mode: "goal", action: "enter", objective: "work" });
			h.addTool("bash");
			await h.modes.set({ mode: "goal", action: "drop" });
			expect(h.tools()).toEqual(
				preexisting ? ["read", "goal", "bash"] : ["read", "bash"],
			);
		}
	});

	test("rolls back a created goal if its tool cannot activate", async () => {
		const h = host({ failActivation: true });
		await expect(
			h.modes.set({ mode: "goal", action: "enter", objective: "work" }),
		).rejects.toThrow("activation failed");
		expect(h.state()).toBeUndefined();
		expect(h.tools()).toEqual(["read"]);
	});

	test("terminal teardown frees the goal slot but never clears a paused goal", async () => {
		const h = host();
		await h.modes.set({ mode: "goal", action: "enter", objective: "work" });
		await h.modes.set({ mode: "goal", action: "pause" });
		await h.owner.settle();
		expect(h.state()?.goal.status).toBe("paused");
		await h.modes.set({ mode: "goal", action: "resume" });
		await h.runtime.completeGoalFromTool();
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: "next" }),
		).toMatchObject({ ok: false, code: "busy" });
		await h.owner.settle();
		expect(h.state()).toBeUndefined();
		expect(h.tools()).toEqual(["read"]);
		expect(h.entries.at(-1)).toMatchObject({
			kind: "goal-completed",
			value: { objective: "work" },
		});
		expect(
			await h.modes.set({ mode: "goal", action: "enter", objective: "next" }),
		).toMatchObject({ ok: true });
	});
});
