import type {
	SessionStopEventResult,
	StopHandlerRun,
	StopObligationAction,
	StopObligationCancellationView,
	StopObligationView,
} from "../extensibility/shared-events";
import type { StopObligationActionOutcome } from "./stop-obligation-action";
import {
	clearIssuerObligations,
	formatStopObligations,
	type HostStopHold,
	HOST_STOP_OBLIGATION_ISSUER,
	LEGACY_BLOCK_OBLIGATION_ID,
	pauseIssuerObligations,
	recordStopBlock,
	reconcileHostHolds,
	type StopObligationState,
} from "./stop-obligations";

/** Issuer recorded for a block whose handler could not be attributed (test doubles, old runners). */
export const UNATTRIBUTED_STOP_ISSUER = "(unattributed)";

export interface StopPassHost {
	readState(): StopObligationState;
	/** Required work the host itself knows is unfinished (a failed native task); never any hook's claim. */
	openHolds?(): readonly HostStopHold[];
	writeState(state: StopObligationState): void;
	/** One `session_stop` emission, reporting each handler's outcome through `onHandlerRun`. */
	emit(
		pending: readonly StopObligationView[],
		cancelled: readonly StopObligationCancellationView[],
		onHandlerRun: (run: StopHandlerRun) => void,
	): Promise<SessionStopEventResult | undefined>;
	runAction(issuer: string, action: StopObligationAction): Promise<StopObligationActionOutcome>;
	notice(level: "info" | "warning" | "error", message: string): void;
}

/**
 * - `settled`: no hook blocked and no obligation remains; the run may end.
 * - `blocked`: a hook blocked; the model must continue with the hook's reason.
 * - `held`: the host's own required work is unfinished; the model gets one more turn at it, then it pauses.
 * - `paused`: obligations remain that no model turn can discharge right now (no progress with nothing left
 *   to try, a hook that cannot judge, a rejected action, an issuer that did not answer). Never success.
 */
export type StopPassOutcome =
	| { kind: "settled"; result: SessionStopEventResult | undefined }
	| { kind: "blocked"; result: SessionStopEventResult }
	| { kind: "held"; detail: string }
	| { kind: "paused"; detail: string };

/**
 * Settle one stop: ask the hooks, apply who cleared / failed / blocked, and run a stuck obligation's
 * action. Loops only through action execution, which is attempted once per progress value, so it ends.
 */
export async function settleStopPass(host: StopPassHost): Promise<StopPassOutcome> {
	for (;;) {
		let state = host.readState();
		const runs: StopHandlerRun[] = [];
		const result = await host.emit(
			state.records.map(record => ({
				issuer: record.issuer,
				id: record.id,
				progress: record.progress,
				stops: record.stops,
				status: record.status,
				actionAttempted: record.actionAttempted,
			})),
			state.cancelled.map(({ issuer, id, progress }) => ({ issuer, id, progress })),
			run => runs.push(run),
		);
		state = { ...state, cancelled: [] };

		const blocked = result?.decision === "block";
		const blockIssuer = blocked ? (result.issuer ?? UNATTRIBUTED_STOP_ISSUER) : undefined;
		let failure: string | undefined;
		for (const [issuer, error] of runOutcomesByIssuer(runs)) {
			if (error !== undefined) {
				const paused = pauseIssuerObligations(state, issuer, `hook failed while re-judging: ${error}`);
				state = paused.state;
				if (paused.paused.length > 0) failure = formatStopObligations(paused.paused);
			} else if (issuer !== blockIssuer) {
				state = clearIssuerObligations(state, issuer);
			}
		}
		if (failure !== undefined) {
			host.writeState(state);
			return { kind: "paused", detail: failure };
		}

		if (!blocked) {
			// A runner that reports no handler runs cannot attribute blocks; their next clean pass clears them.
			state = clearIssuerObligations(state, UNATTRIBUTED_STOP_ISSUER);
			const holds = host.openHolds?.() ?? [];
			const reconciled = reconcileHostHolds(state, holds);
			state = reconciled.state;
			host.writeState(state);
			if (state.records.length === 0) return { kind: "settled", result };
			if (reconciled.pause !== undefined) return { kind: "paused", detail: formatStopObligations(state.records) };
			if (state.records.every(record => record.issuer === HOST_STOP_OBLIGATION_ISSUER && record.status === "pending")) {
				return { kind: "held", detail: formatStopObligations(state.records) };
			}
			return { kind: "paused", detail: formatStopObligations(state.records) };
		}

		const issuer = blockIssuer ?? UNATTRIBUTED_STOP_ISSUER;
		const claim = result.obligation ?? { id: LEGACY_BLOCK_OBLIGATION_ID };
		const reason = result.reason ?? result.additionalContext ?? "";
		// One block states the hook's whole judgment: its other obligations are no longer owed.
		const held = { ...state, records: state.records.filter(r => r.issuer !== issuer || r.id === claim.id) };
		const recorded = recordStopBlock(held, issuer, claim, reason);
		host.writeState(recorded.state);
		const { plan } = recorded;
		if (plan.kind === "continue") return { kind: "blocked", result };
		if (plan.kind === "pause") return { kind: "paused", detail: plan.detail };

		host.notice("info", `Stop obligation ${claim.id} is stuck; running its action ${plan.action.tool}.`);
		const outcome = await host.runAction(issuer, plan.action);
		if (outcome.kind === "rejected") {
			const paused = pauseIssuerObligations(recorded.state, issuer, outcome.detail);
			host.writeState(paused.state);
			return { kind: "paused", detail: outcome.detail };
		}
		if (outcome.error !== undefined) {
			host.notice("warning", `Stop obligation action ${plan.action.tool} failed: ${outcome.error}`);
		}
		// The action's own result is never proof: loop so the issuing hook re-judges.
	}
}

function runOutcomesByIssuer(runs: readonly StopHandlerRun[]): Map<string, string | undefined> {
	const outcomes = new Map<string, string | undefined>();
	for (const run of runs) {
		if (run.error !== undefined) outcomes.set(run.issuer, run.error);
		else if (!outcomes.has(run.issuer)) outcomes.set(run.issuer, undefined);
	}
	return outcomes;
}
