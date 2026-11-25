import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type {
	SessionStopEventResult,
	StopHandlerRun,
	StopObligationCancellationView,
	StopObligationView,
} from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { runStopObligationAction } from "@oh-my-pi/pi-coding-agent/session/stop-obligation-action";
import { type StopPassHost, settleStopPass } from "@oh-my-pi/pi-coding-agent/session/stop-obligation-pass";
import {
	cancelStopObligations,
	CORRUPT_STOP_OBLIGATION_ISSUER,
	EMPTY_STOP_OBLIGATION_STATE,
	parseStopObligationState,
	type StopObligationState,
} from "@oh-my-pi/pi-coding-agent/session/stop-obligations";

const REVIEW_HOOK = "/ext/review.ts";
const SYNTHETIC_HOOK = "/ext/synthetic.ts";

type HookScript = (
	pending: readonly StopObligationView[],
	cancelled: readonly StopObligationCancellationView[],
) => { result?: SessionStopEventResult; runs: StopHandlerRun[] };

/** A stop host over an in-memory obligation store; `hooks` plays the extensions' session_stop handlers. */
function createHost(hooks: HookScript, runAction: StopPassHost["runAction"]) {
	let state: StopObligationState = EMPTY_STOP_OBLIGATION_STATE;
	const notices: string[] = [];
	const host: StopPassHost = {
		readState: () => state,
		writeState: next => {
			state = next;
		},
		emit: async (pending, cancelled, onHandlerRun) => {
			const { result, runs } = hooks(pending, cancelled);
			for (const run of runs) onHandlerRun(run);
			return result;
		},
		runAction,
		notice: (_level, message) => notices.push(message),
	};
	return { host, notices, state: () => state, setState: (next: StopObligationState) => (state = next) };
}

const noAction: StopPassHost["runAction"] = async () => {
	throw new Error("no action expected");
};

function block(issuer: string, reason: string, obligation?: SessionStopEventResult["obligation"]): HookScript {
	return () => ({
		result: { decision: "block", reason, issuer, ...(obligation && { obligation }) },
		runs: [{ issuer }],
	});
}

describe("stop obligations", () => {
	it("keeps a text-only block that an ignoring writer repeats from ever settling as success", async () => {
		const { host, state } = createHost(block(REVIEW_HOOK, "rewrite ops.ts"), noAction);
		const outcomes: string[] = [];
		for (let stop = 1; stop <= 6; stop++) outcomes.push((await settleStopPass(host)).kind);
		// Two writer attempts, then paused. A later stop (a new user turn) gives the writer another run at it,
		// and the obligation is never "settled" however often the writer refuses.
		expect(outcomes.slice(0, 3)).toEqual(["blocked", "blocked", "paused"]);
		expect(outcomes).not.toContain("settled");
		expect(state().records).toHaveLength(1);
		expect(state().records[0]?.status).toBe("paused");
	});

	it("runs the hook's structured action on the second no-progress stop, then lets the hook re-judge", async () => {
		const actions: string[] = [];
		const claim = {
			id: "design-review",
			progress: "src-hash-1",
			action: { tool: "rewrite", args: { target: "ops.ts" }, basis: "src-hash-1" },
		};
		const hooks: HookScript = () =>
			actions.length === 0
				? {
						result: { decision: "block", reason: "rewrite", issuer: REVIEW_HOOK, obligation: claim },
						runs: [{ issuer: REVIEW_HOOK }],
					}
				: { result: undefined, runs: [{ issuer: REVIEW_HOOK }] };
		const { host, state } = createHost(hooks, async (issuer, action) => {
			actions.push(`${issuer}:${action.tool}`);
			return { kind: "ran" };
		});

		expect((await settleStopPass(host)).kind).toBe("blocked"); // stop 1: the writer is asked
		const second = await settleStopPass(host); // stop 2: no progress -> host acts, hook re-judges clean
		expect(actions).toEqual([`${REVIEW_HOOK}:rewrite`]);
		expect(second.kind).toBe("settled");
		expect(state().records).toEqual([]);
	});

	it("never counts the action's success as proof: an unchanged source after the action stays pending, then pauses", async () => {
		let ran = 0;
		const claim = {
			id: "design-review",
			progress: "src-hash-1",
			action: { tool: "rewrite", args: {}, basis: "src-hash-1" },
		};
		const { host, state } = createHost(block(REVIEW_HOOK, "still bad", claim), async () => {
			ran++;
			return { kind: "ran" };
		});
		await settleStopPass(host);
		// Stop 2 runs the action; the hook re-judges the unchanged source, still blocks, and the obligation pauses.
		const afterAction = await settleStopPass(host);
		expect(ran).toBe(1);
		expect(afterAction.kind).toBe("paused");
		expect(state().records[0]?.status).toBe("paused");
		// A later stop must not re-run the action for the same progress value.
		for (let stop = 0; stop < 4; stop++) await settleStopPass(host);
		expect(ran).toBe(1);
	});

	it("does not clear on changed progress alone, and restarts the count", async () => {
		let progress = 0;
		const hooks: HookScript = () => ({
			result: {
				decision: "block",
				reason: "x",
				issuer: REVIEW_HOOK,
				obligation: { id: "o", progress: `p${progress++}` },
			},
			runs: [{ issuer: REVIEW_HOOK }],
		});
		const { host, state } = createHost(hooks, noAction);
		for (let stop = 0; stop < 5; stop++) expect((await settleStopPass(host)).kind).toBe("blocked");
		expect(state().records).toHaveLength(1);
		expect(state().records[0]?.stops).toBe(1);
	});

	it("rejects an action with a stale or missing basis and pauses with the obligation pending", async () => {
		const claim = { id: "o", progress: "p2", action: { tool: "rewrite", args: {}, basis: "p1" } };
		const { host, state } = createHost(block(REVIEW_HOOK, "r", claim), noAction);
		await settleStopPass(host);
		const second = await settleStopPass(host);
		expect(second.kind).toBe("paused");
		expect(state().records[0]?.status).toBe("paused");
	});

	it("pauses at once when the hook says it cannot judge, never as success", async () => {
		const { host, state } = createHost(
			block(REVIEW_HOOK, "provider outage", { id: "design-review", unavailable: true }),
			noAction,
		);
		expect((await settleStopPass(host)).kind).toBe("paused");
		expect(state().records[0]?.status).toBe("paused");
	});

	it("a hook that throws while it holds an obligation pauses it; its error is not clearance", async () => {
		const first = createHost(block(REVIEW_HOOK, "r"), noAction);
		await settleStopPass(first.host);
		const hooks: HookScript = () => ({ result: undefined, runs: [{ issuer: REVIEW_HOOK, error: "boom" }] });
		const failing = createHost(hooks, noAction);
		failing.setState(first.state());
		const outcome = await settleStopPass(failing.host);
		expect(outcome.kind).toBe("paused");
		expect(failing.state().records[0]?.status).toBe("paused");
	});

	it("a hook that throws on its FIRST run, holding no obligation yet, is an outage that pauses: it never settles as success", async () => {
		const hooks: HookScript = () => ({ result: undefined, runs: [{ issuer: REVIEW_HOOK, error: "judge provider down" }] });
		const { host, state } = createHost(hooks, noAction);
		const outcome = await settleStopPass(host);
		expect(outcome.kind).toBe("paused");
		// The outage is recorded as pending work, so a later clean recheck by the same hook is what clears it.
		expect(state().records.map(record => [record.issuer, record.status])).toEqual([[REVIEW_HOOK, "paused"]]);
		const recovered = createHost(() => ({ result: undefined, runs: [{ issuer: REVIEW_HOOK }] }), noAction);
		recovered.setState(state());
		expect((await settleStopPass(recovered.host)).kind).toBe("settled");
		expect(recovered.state().records).toEqual([]);
	});

	it("a different hook's clean pass does not clear another hook's obligation", async () => {
		const first = createHost(block(REVIEW_HOOK, "r"), noAction);
		await settleStopPass(first.host);
		const hooks: HookScript = () => ({ result: undefined, runs: [{ issuer: SYNTHETIC_HOOK }] });
		const other = createHost(hooks, noAction);
		other.setState(first.state());
		const outcome = await settleStopPass(other.host);
		expect(outcome.kind).toBe("paused");
		expect(other.state().records).toHaveLength(1);
	});

	it("an issuer that does not run at all leaves its obligation owed", async () => {
		const first = createHost(block(REVIEW_HOOK, "r"), noAction);
		await settleStopPass(first.host);
		const silent = createHost(() => ({ result: undefined, runs: [] }), noAction);
		silent.setState(first.state());
		expect((await settleStopPass(silent.host)).kind).toBe("paused");
	});

	it("two independent hooks use the same mechanism: each one's clean recheck clears only its own", async () => {
		const state: StopObligationState = {
			records: [
				{
					issuer: REVIEW_HOOK,
					id: "a",
					progress: "1",
					stops: 1,
					actionAttempted: false,
					status: "pending",
					detail: "a",
				},
				{
					issuer: SYNTHETIC_HOOK,
					id: "b",
					progress: "1",
					stops: 1,
					actionAttempted: false,
					status: "pending",
					detail: "b",
				},
			],
			cancelled: [],
		};
		const hooks: HookScript = () => ({ result: undefined, runs: [{ issuer: SYNTHETIC_HOOK }] });
		const harness = createHost(hooks, noAction);
		harness.setState(state);
		expect((await settleStopPass(harness.host)).kind).toBe("paused");
		expect(harness.state().records.map(record => record.issuer)).toEqual([REVIEW_HOOK]);
	});

	it("survives reload: the persisted entry restores the exact state; unreadable data becomes a paused sentinel, never clearance", async () => {
		const first = createHost(block(REVIEW_HOOK, "r"), noAction);
		await settleStopPass(first.host);
		const restored = parseStopObligationState(JSON.parse(JSON.stringify(first.state())));
		expect(restored).toEqual(first.state());
		for (const damaged of [
			undefined,
			"x",
			{ records: [{ issuer: 1 }], cancelled: [] },
			{ records: [], cancelled: "x" },
		]) {
			const parsed = parseStopObligationState(damaged);
			expect(parsed.records.map(record => [record.issuer, record.status])).toContainEqual([
				CORRUPT_STOP_OBLIGATION_ISSUER,
				"paused",
			]);
		}
		// Only the user can clear the sentinel; no hook runs as it.
		const sentinel = parseStopObligationState(undefined);
		const hooks: HookScript = () => ({ result: undefined, runs: [{ issuer: REVIEW_HOOK }] });
		const harness = createHost(hooks, noAction);
		harness.setState(sentinel);
		expect((await settleStopPass(harness.host)).kind).toBe("paused");
		const cancelled = cancelStopObligations(sentinel, { id: "corrupt" });
		expect(cancelled.state.records).toEqual([]);
	});

	it("a user cancellation drops the obligation and tells its issuer exactly which progress was waived", async () => {
		const first = createHost(block(REVIEW_HOOK, "r", { id: "o", progress: "p9" }), noAction);
		await settleStopPass(first.host);
		const cancelled = cancelStopObligations(first.state(), { id: "o" });
		expect(cancelled.removed).toHaveLength(1);
		let heard: readonly StopObligationCancellationView[] = [];
		const hooks: HookScript = (_pending, cancelledViews) => {
			heard = cancelledViews;
			return { result: undefined, runs: [{ issuer: REVIEW_HOOK }] };
		};
		const next = createHost(hooks, noAction);
		next.setState(cancelled.state);
		expect((await settleStopPass(next.host)).kind).toBe("settled");
		expect(heard).toEqual([{ issuer: REVIEW_HOOK, id: "o", progress: "p9" }]);
		expect(next.state().cancelled).toEqual([]);
	});

	it("an action that throws counts as attempted and the pass still ends in a pause, not success", async () => {
		const claim = { id: "o", progress: "p", action: { tool: "rewrite", args: {}, basis: "p" } };
		let ran = 0;
		const { host } = createHost(block(REVIEW_HOOK, "r", claim), async () => {
			ran++;
			return { kind: "ran", error: "worker failed" };
		});
		await settleStopPass(host);
		const second = await settleStopPass(host);
		expect(second.kind).toBe("paused");
		expect(ran).toBe(1);
	});
});

describe("runStopObligationAction", () => {
	const issuer = REVIEW_HOOK;
	const context = {} as AgentToolContext;
	const signal = new AbortController().signal;

	function tool(execute: AgentTool["execute"], schemaRequiresTarget = true): AgentTool {
		return {
			name: "rewrite",
			label: "rewrite",
			description: "d",
			parameters: {
				type: "object",
				properties: { target: { type: "string" } },
				required: schemaRequiresTarget ? ["target"] : [],
				additionalProperties: false,
			},
			execute,
		} as unknown as AgentTool;
	}

	it("dispatches the registered tool through the registry with validated arguments", async () => {
		const seen: unknown[] = [];
		const outcome = await runStopObligationAction({
			action: { tool: "rewrite", args: { target: "ops.ts" }, basis: "p" },
			issuer,
			registeredBy: () => issuer,
			findTool: () =>
				tool(async (_id, args) => {
					seen.push(args);
					return { content: [] };
				}),
			context,
			signal,
			toolCallId: "t1",
		});
		expect(outcome).toEqual({ kind: "ran" });
		expect(seen).toEqual([{ target: "ops.ts" }]);
	});

	it("refuses a tool another extension registered, an unknown tool, and arguments that fail the schema", async () => {
		const base = { issuer, context, signal, toolCallId: "t1", findTool: () => tool(async () => ({ content: [] })) };
		expect(
			(
				await runStopObligationAction({
					...base,
					action: { tool: "rewrite", args: { target: "x" }, basis: "p" },
					registeredBy: () => SYNTHETIC_HOOK,
				})
			).kind,
		).toBe("rejected");
		expect(
			(
				await runStopObligationAction({
					...base,
					action: { tool: "rewrite", args: { target: "x" }, basis: "p" },
					registeredBy: () => issuer,
					findTool: () => undefined,
				})
			).kind,
		).toBe("rejected");
		expect(
			(
				await runStopObligationAction({
					...base,
					action: { tool: "rewrite", args: { nope: 1 }, basis: "p" },
					registeredBy: () => issuer,
				})
			).kind,
		).toBe("rejected");
	});

	it("reports a throwing or blocked tool as ran-with-error, never as success", async () => {
		const outcome = await runStopObligationAction({
			action: { tool: "rewrite", args: { target: "x" }, basis: "p" },
			issuer,
			registeredBy: () => issuer,
			findTool: () =>
				tool(async () => {
					throw new Error("blocked by approval");
				}),
			context,
			signal,
			toolCallId: "t1",
		});
		expect(outcome).toEqual({ kind: "ran", error: "blocked by approval" });
	});
});
