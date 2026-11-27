import type { SessionModeRequest, SessionModeState } from "../extensibility/extensions/types";
import type { GoalModeState } from "../goals/state";

export type GoalRequest = Extract<SessionModeRequest, { mode: "goal" }>;
export type GoalTransition =
	| { kind: "unchanged" }
	| { kind: "refused"; code: "conflict" | "disabled" | "invalid_request"; message: string }
	| { kind: "transition"; request: GoalRequest };

export function readGoalModeState(
	state: GoalModeState | undefined,
	plan: { enabled: boolean; planFilePath: string } | undefined,
	vibe: { enabled: boolean } | undefined,
): SessionModeState {
	const inactive = !state || state.goal.status === "dropped" || state.goal.status === "complete";
	return {
		goal: inactive ? { status: "inactive" } : {
			status: state.enabled ? "active" : "paused",
			objective: state.goal.objective,
			tokenBudget: state.goal.tokenBudget,
		},
		plan: { status: plan ? (plan.enabled ? "active" : "paused") : "inactive", planFilePath: plan?.planFilePath },
		vibe: { status: vibe?.enabled ? "active" : "inactive" },
		loop: { status: "inactive" },
	};
}

export function decideGoalTransition(request: GoalRequest, state: SessionModeState, enabled: boolean): GoalTransition {
	const invalid = (message: string): GoalTransition => ({ kind: "refused", code: "invalid_request", message });
	if (request.action === "drop") {
		return state.goal.status === "inactive" ? { kind: "unchanged" } : { kind: "transition", request };
	}
	if (request.action === "pause") {
		if (state.goal.status === "paused") return { kind: "unchanged" };
		if (state.goal.status === "inactive") return invalid("There is no active goal to pause.");
		return { kind: "transition", request };
	}
	if (!enabled) return { kind: "refused", code: "disabled", message: "Goal mode is disabled in settings (goal.enabled)." };
	if (request.action === "enter") {
		if (!request.objective?.trim()) return invalid("Goal objective must be a non-empty string.");
		if (request.tokenBudget !== undefined && (!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0)) {
			return invalid("Goal tokenBudget must be a positive integer.");
		}
		if (state.goal.status === "active") {
			return state.goal.objective === request.objective.trim() && state.goal.tokenBudget === request.tokenBudget
				? { kind: "unchanged" }
				: invalid("A goal is already active; drop it before setting a new objective.");
		}
		if (state.goal.status === "paused") return invalid("Resume or drop the paused goal first.");
	} else {
		if (state.goal.status === "active") return { kind: "unchanged" };
		if (state.goal.status !== "paused") return invalid("There is no paused goal to resume.");
	}
	if (state.plan.status !== "inactive") return { kind: "refused", code: "conflict", message: "Exit plan mode first." };
	if (state.vibe.status !== "inactive") return { kind: "refused", code: "conflict", message: "Exit vibe mode first." };
	return { kind: "transition", request };
}
