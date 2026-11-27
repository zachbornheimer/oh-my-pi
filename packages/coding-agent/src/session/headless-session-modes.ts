import type {
	ExtensionSessionModes,
	SessionModeRequest,
	SessionModeResult,
	SessionModeState,
} from "../extensibility/extensions/types";
import { cfgExtensionHandlersModeControl } from "../extensibility/settings";
import { cfgGoalEnabled } from "../goals/settings";
import type { AgentSession } from "./agent-session";

type GoalSession = Pick<
	AgentSession,
	| "settings"
	| "goalRuntime"
	| "sessionManager"
	| "isBusyForSnapshot"
	| "isSessionTransitioning"
	| "getGoalModeState"
	| "setGoalModeState"
	| "getPlanModeState"
	| "getVibeModeState"
	| "getEnabledToolNames"
	| "setActiveToolsByName"
>;

type GoalRequest = Extract<SessionModeRequest, { mode: "goal" }>;
type Plan =
	| { kind: "unchanged" }
	| {
			kind: "refused";
			code: "conflict" | "disabled" | "invalid_request";
			message: string;
	  }
	| { kind: "transition"; request: GoalRequest };

interface ToolOwnership {
	added: boolean;
	transitioning: boolean;
}
const ownership = new WeakMap<GoalSession, ToolOwnership>();

function snapshot(session: GoalSession): SessionModeState {
	const state = session.getGoalModeState();
	const plan = session.getPlanModeState();
	const goal: SessionModeState["goal"] =
		!state ||
		state.goal.status === "dropped" ||
		state.goal.status === "complete"
			? { status: "inactive" }
			: {
					status: state.enabled ? "active" : "paused",
					objective: state.goal.objective,
					tokenBudget: state.goal.tokenBudget,
				};
	return {
		goal,
		plan: {
			status: plan ? (plan.enabled ? "active" : "paused") : "inactive",
			planFilePath: plan?.planFilePath,
		},
		vibe: {
			status: session.getVibeModeState()?.enabled ? "active" : "inactive",
		},
		loop: { status: "inactive" },
	};
}

function decide(
	request: SessionModeRequest,
	state: SessionModeState,
	enabled: boolean,
): Plan {
	const invalid = (message: string): Plan => ({
		kind: "refused",
		code: "invalid_request",
		message,
	});
	if (request.mode !== "goal")
		return invalid("Only goal mode is available in this headless host.");
	if (request.action === "drop")
		return state.goal.status === "inactive"
			? { kind: "unchanged" }
			: { kind: "transition", request };
	if (request.action === "pause")
		return state.goal.status === "paused"
			? { kind: "unchanged" }
			: state.goal.status === "inactive"
				? invalid("There is no active goal to pause.")
				: { kind: "transition", request };
	if (!enabled)
		return {
			kind: "refused",
			code: "disabled",
			message: "Goal mode is disabled in settings (goal.enabled).",
		};
	if (request.action === "enter") {
		if (!request.objective?.trim())
			return invalid("Goal objective must be a non-empty string.");
		if (
			request.tokenBudget !== undefined &&
			(!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0)
		)
			return invalid("Goal tokenBudget must be a positive integer.");
		if (state.goal.status === "active") {
			return state.goal.objective === request.objective.trim() &&
				state.goal.tokenBudget === request.tokenBudget
				? { kind: "unchanged" }
				: invalid(
						"A goal is already active; drop it before setting a new objective.",
					);
		}
		if (state.goal.status === "paused")
			return invalid("Resume or drop the paused goal first.");
	} else if (state.goal.status === "active") return { kind: "unchanged" };
	else if (state.goal.status !== "paused")
		return invalid("There is no paused goal to resume.");
	if (state.plan.status !== "inactive")
		return {
			kind: "refused",
			code: "conflict",
			message: "Exit plan mode first.",
		};
	if (state.vibe.status !== "inactive")
		return {
			kind: "refused",
			code: "conflict",
			message: "Exit vibe mode first.",
		};
	return { kind: "transition", request };
}

async function removeOwnedGoalTool(
	session: GoalSession,
	tools: ToolOwnership,
): Promise<void> {
	if (!tools.added) return;
	const enabled = session.getEnabledToolNames();
	if (enabled.includes("goal"))
		await session.setActiveToolsByName(
			enabled.filter((name) => name !== "goal"),
		);
	tools.added = false;
}

async function execute(
	session: GoalSession,
	request: GoalRequest,
	tools: ToolOwnership,
): Promise<void> {
	const action = request.action;
	if (action === "pause" || action === "drop") {
		if (action === "pause") await session.goalRuntime.pauseGoal();
		else await session.goalRuntime.dropGoal();
		await removeOwnedGoalTool(session, tools);
		return;
	}
	const enabled = session.getEnabledToolNames();
	const added = !enabled.includes("goal");
	const state =
		request.action === "enter"
			? await session.goalRuntime.createGoal({
					objective: request.objective,
					tokenBudget: request.tokenBudget,
				})
			: await session.goalRuntime.resumeGoal();
	try {
		await session.setActiveToolsByName(added ? [...enabled, "goal"] : enabled);
		tools.added ||= added;
		session.setGoalModeState(state);
	} catch (error) {
		if (action === "resume") await session.goalRuntime.pauseGoal();
		else await session.goalRuntime.dropGoal();
		throw error;
	}
}

/** Headless mode control uses the same goal runtime, accounting, persistence, and tool roster as the session. */
export function createHeadlessSessionModes(
	session: GoalSession,
): ExtensionSessionModes {
	const tools = ownership.get(session) ?? {
		added: false,
		transitioning: false,
	};
	ownership.set(session, tools);
	return {
		getState: () => snapshot(session),
		async set(request) {
			const refuse = (
				code: Extract<SessionModeResult, { ok: false }>["code"],
				message: string,
			): SessionModeResult => ({
				ok: false,
				code,
				message,
				state: snapshot(session),
			});
			if (!cfgExtensionHandlersModeControl.get(session.settings))
				return refuse(
					"disabled",
					"Extension mode control is disabled in settings (extensionHandlers.modeControl).",
				);
			if (
				tools.transitioning ||
				session.isSessionTransitioning ||
				session.getGoalModeState()?.mode === "exiting"
			)
				return refuse(
					"busy",
					"A session or goal mode transition is still settling.",
				);
			const plan = decide(
				request,
				snapshot(session),
				cfgGoalEnabled.get(session.settings),
			);
			if (plan.kind === "refused") return refuse(plan.code, plan.message);
			if (plan.kind === "unchanged")
				return { ok: true, changed: false, state: snapshot(session) };
			if (session.isBusyForSnapshot)
				return refuse(
					"busy",
					"The session is busy with a turn or compaction; retry once it is idle.",
				);
			tools.transitioning = true;
			try {
				await execute(session, plan.request, tools);
			} finally {
				tools.transitioning = false;
			}
			return { ok: true, changed: true, state: snapshot(session) };
		},
	};
}

/** Finish only terminal teardown; a paused or budget-limited goal remains available for explicit user control. */
export async function finalizeHeadlessGoalMode(
	session: GoalSession,
): Promise<void> {
	const tools = ownership.get(session);
	if (!tools) return;
	const state = session.getGoalModeState();
	if (state?.goal.status === "complete" && state.mode === "exiting") {
		if (tools) await removeOwnedGoalTool(session, tools);
		session.setGoalModeState(undefined);
		session.sessionManager.appendModeChange("none");
		session.sessionManager.appendCustomEntry("goal-completed", {
			objective: state.goal.objective,
			tokensUsed: state.goal.tokensUsed,
			tokenBudget: state.goal.tokenBudget,
			timeUsedSeconds: state.goal.timeUsedSeconds,
		});
	} else if (state && !state.enabled && tools)
		await removeOwnedGoalTool(session, tools);
}
