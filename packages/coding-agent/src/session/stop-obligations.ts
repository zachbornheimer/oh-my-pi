/**
 * Stop obligations: required work a `session_stop` hook blocked on, tracked until the SAME hook
 * clears it or the user cancels it.
 *
 * A hook-reported block names an obligation (`id`) and the state of the work (`progress`). The
 * host, not the model, counts consecutive stops that leave `progress` unchanged: the second runs
 * the hook's structured `action` (a registered tool plus arguments), the third with nothing left
 * to try pauses the obligation. A paused or pending obligation is never success; it survives
 * reload because the whole state is a custom session entry.
 *
 * This module is pure: it decides and returns the next state. The session owns effects.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { StopObligationAction, StopObligationClaim } from "../extensibility/shared-events";

/** `customType` of the session entry holding the latest {@link StopObligationState}. */
export const STOP_OBLIGATIONS_CUSTOM_TYPE = "stop-obligations";

/** Consecutive stops with unchanged progress before an obligation with nothing left to try pauses. */
export const STOP_OBLIGATION_PAUSE_AFTER_STOPS = 3;
/** Consecutive stops with unchanged progress after which the hook's action runs. */
export const STOP_OBLIGATION_ACTION_AFTER_STOPS = 2;

/** The id a block without an explicit `obligation` is tracked under. */
export const LEGACY_BLOCK_OBLIGATION_ID = "block";

export interface StopObligationRecord {
	/** Extension path of the hook that raised it; only this hook can clear it. */
	issuer: string;
	id: string;
	/** Hook-reported state of the work at the latest stop. */
	progress: string;
	/** Consecutive stops at this `progress`. */
	stops: number;
	/** The hook's action already ran (or was refused) for this `progress`. */
	actionAttempted: boolean;
	status: "pending" | "paused";
	/** Why the obligation is paused, or the hook's latest reason while pending. */
	detail: string;
}

export interface StopObligationCancellation {
	issuer: string;
	id: string;
	progress: string;
}

export interface StopObligationState {
	records: StopObligationRecord[];
	/** User cancellations not yet reported to their issuer. */
	cancelled: StopObligationCancellation[];
}

export const EMPTY_STOP_OBLIGATION_STATE: StopObligationState = { records: [], cancelled: [] };

/** What the session does next about a block. */
export type StopObligationPlan =
	| { kind: "continue" }
	| { kind: "action"; action: StopObligationAction }
	| { kind: "pause"; detail: string };

export function stopObligationKey(issuer: string, id: string): string {
	return `${issuer}\u0000${id}`;
}

function digest(text: string): string {
	return Bun.hash(text).toString(36);
}

function upsert(state: StopObligationState, record: StopObligationRecord): StopObligationState {
	const key = stopObligationKey(record.issuer, record.id);
	const others = state.records.filter(existing => stopObligationKey(existing.issuer, existing.id) !== key);
	return { ...state, records: [...others, record] };
}

/** Decide what a hook's block means for its obligation. */
export function recordStopBlock(
	state: StopObligationState,
	issuer: string,
	claim: StopObligationClaim,
	reason: string,
): { state: StopObligationState; plan: StopObligationPlan } {
	const progress = claim.progress ?? digest(reason);
	const previous = state.records.find(record => record.issuer === issuer && record.id === claim.id);
	const base: StopObligationRecord = {
		issuer,
		id: claim.id,
		progress,
		stops: 1,
		actionAttempted: false,
		status: "pending",
		detail: reason,
	};

	if (claim.unavailable === true) {
		const detail = `${reason} (hook cannot judge right now)`;
		const record: StopObligationRecord = { ...base, stops: (previous?.stops ?? 0) + 1, status: "paused", detail };
		return { state: upsert(state, record), plan: { kind: "pause", detail } };
	}

	// New obligation or changed progress: counting restarts.
	if (!previous || previous.progress !== progress) {
		return { state: upsert(state, base), plan: { kind: "continue" } };
	}
	// Revived by a new user turn after a pause: the writer gets a fresh run at it, but the hook's action
	// still runs once per progress value.
	if (previous.status === "paused") {
		return {
			state: upsert(state, { ...base, actionAttempted: previous.actionAttempted }),
			plan: { kind: "continue" },
		};
	}

	const stops = previous.stops + 1;
	const next: StopObligationRecord = { ...previous, stops, detail: reason };
	const action = claim.action;
	if (action && !previous.actionAttempted && stops >= STOP_OBLIGATION_ACTION_AFTER_STOPS) {
		// An action is only valid for the exact work state it was computed for.
		if (action.basis !== progress) {
			const detail = `stale action for ${claim.id}: basis ${action.basis ?? "(none)"} is not current progress ${progress}`;
			return {
				state: upsert(state, { ...next, actionAttempted: true, status: "paused", detail }),
				plan: { kind: "pause", detail },
			};
		}
		return { state: upsert(state, { ...next, actionAttempted: true }), plan: { kind: "action", action } };
	}
	if (stops >= STOP_OBLIGATION_PAUSE_AFTER_STOPS) {
		const detail = `${stops} consecutive stops without progress on ${claim.id}: ${reason}`;
		return {
			state: upsert(state, { ...next, status: "paused", detail }),
			plan: { kind: "pause", detail },
		};
	}
	return { state: upsert(state, next), plan: { kind: "continue" } };
}

/** The issuer's hook ran cleanly and did not block: every obligation it held is satisfied. */
export function clearIssuerObligations(state: StopObligationState, issuer: string): StopObligationState {
	if (!state.records.some(record => record.issuer === issuer)) return state;
	return { ...state, records: state.records.filter(record => record.issuer !== issuer) };
}

/** The issuer's hook errored or timed out while it still held obligations: they pause, never clear. */
export function pauseIssuerObligations(
	state: StopObligationState,
	issuer: string,
	detail: string,
): { state: StopObligationState; paused: StopObligationRecord[] } {
	const paused: StopObligationRecord[] = [];
	const records = state.records.map(record => {
		if (record.issuer !== issuer) return record;
		const next: StopObligationRecord = { ...record, status: "paused", detail };
		paused.push(next);
		return next;
	});
	return { state: { ...state, records }, paused };
}

/** The user cancelled obligations: drop them and remember the exact progress for the issuer. */
export function cancelStopObligations(
	state: StopObligationState,
	selector: { id?: string; issuer?: string },
): { state: StopObligationState; removed: StopObligationRecord[] } {
	const matches = (record: StopObligationRecord): boolean =>
		(selector.id === undefined || record.id === selector.id) &&
		(selector.issuer === undefined || record.issuer === selector.issuer);
	const removed = state.records.filter(matches);
	if (removed.length === 0) return { state, removed };
	return {
		state: {
			records: state.records.filter(record => !matches(record)),
			cancelled: [
				...state.cancelled,
				...removed.map(record => ({ issuer: record.issuer, id: record.id, progress: record.progress })),
			],
		},
		removed,
	};
}

/** Issuer of the record standing in for persisted state that could not be read. No hook runs as it, so only a user cancel clears it. */
export const CORRUPT_STOP_OBLIGATION_ISSUER = "(corrupt-stop-obligation-state)";

/**
 * Parse a persisted entry's data. Unreadable state must not read as "nothing owed": whatever could not be
 * parsed is replaced by a paused sentinel obligation the user has to look at.
 */
export function parseStopObligationState(data: unknown): StopObligationState {
	const corrupt: StopObligationRecord = {
		issuer: CORRUPT_STOP_OBLIGATION_ISSUER,
		id: "corrupt",
		progress: "corrupt",
		stops: 0,
		actionAttempted: true,
		status: "paused",
		detail:
			"the saved stop-obligation state is unreadable; required work may be owed. Review it, then /obligations cancel corrupt",
	};
	if (!isRecord(data) || !Array.isArray(data.records) || !Array.isArray(data.cancelled)) {
		return { records: [corrupt], cancelled: [] };
	}
	const records = data.records.filter(isObligationRecord);
	const cancelled = data.cancelled.filter(isCancellation);
	const intact = records.length === data.records.length && cancelled.length === data.cancelled.length;
	return { records: intact ? records : [...records, corrupt], cancelled };
}

function isObligationRecord(value: unknown): value is StopObligationRecord {
	if (!isRecord(value)) return false;
	const record = value;
	return (
		typeof record.issuer === "string" &&
		typeof record.id === "string" &&
		typeof record.progress === "string" &&
		typeof record.stops === "number" &&
		typeof record.actionAttempted === "boolean" &&
		(record.status === "pending" || record.status === "paused") &&
		typeof record.detail === "string"
	);
}

function isCancellation(value: unknown): value is StopObligationCancellation {
	if (!isRecord(value)) return false;
	const entry = value;
	return typeof entry.issuer === "string" && typeof entry.id === "string" && typeof entry.progress === "string";
}

/** One line per obligation for notices, `/obligations`, print and RPC output. */
export function formatStopObligations(records: readonly StopObligationRecord[]): string {
	return records.map(record => `[${record.status}] ${record.id} (${record.issuer}): ${record.detail}`).join("\n");
}
