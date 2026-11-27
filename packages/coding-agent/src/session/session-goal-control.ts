import type { SessionModeResult } from "../extensibility/extensions/types";
import { cfgExtensionHandlersModeControl } from "../extensibility/settings";
import { cfgGoalEnabled } from "../goals/settings";
import type { AgentSession } from "./agent-session";
import { decideGoalTransition, type GoalRequest, readGoalModeState } from "./goal-mode-policy";
import type { GoalModeControl } from "./headless-session-modes";

export type GoalControlHost = Pick<AgentSession,
	"settings" | "goalRuntime" | "isBusyForSnapshot" | "isSessionTransitioning" |
	"getGoalModeState" | "setGoalModeState" | "getPlanModeState" | "getVibeModeState"
> & {
	sessionManager: {
		appendModeChange(mode: "none"): void;
		appendCustomEntry(kind: string, value: unknown): void;
	};
	setGoalToolContribution(enabled: boolean): Promise<void>;
	runGoalTransition(work: () => Promise<SessionModeResult>): Promise<SessionModeResult>;
};

/** Owned by the session; admission shares its transcript-transition authority. */
export class SessionGoalControl implements GoalModeControl {
	constructor(readonly host: GoalControlHost) {}

	readState() {
		return readGoalModeState(this.host.getGoalModeState(), this.host.getPlanModeState(), this.host.getVibeModeState());
	}

	private refuse(code: Extract<SessionModeResult, { ok: false }>["code"], message: string): SessionModeResult {
		return { ok: false, code, message, state: this.readState() };
	}

	async requestFromExtension(request: GoalRequest): Promise<SessionModeResult> {
		if (!cfgExtensionHandlersModeControl.get(this.host.settings)) {
			return this.refuse("disabled", "Extension mode control is disabled in settings (extensionHandlers.modeControl).");
		}
		if (this.host.isSessionTransitioning || this.host.getGoalModeState()?.mode === "exiting") {
			return this.refuse("busy", "A session or goal mode transition is still settling.");
		}
		return this.host.runGoalTransition(() => this.transition(request));
	}

	/** Called inside the session's transition scope, after checking admission. */
	private async transition(request: GoalRequest): Promise<SessionModeResult> {
		const observation = this.readState();
		const plan = decideGoalTransition(request, observation, cfgGoalEnabled.get(this.host.settings));
		if (plan.kind === "refused") return this.refuse(plan.code, plan.message);
		if (plan.kind === "unchanged") return { ok: true, changed: false, state: observation };
		if (this.host.isBusyForSnapshot) {
			return this.refuse("busy", "The session is busy with a turn or compaction; retry once it is idle.");
		}
		await this.executeTransition(plan.request);
		return { ok: true, changed: true, state: this.readState() };
	}

	private async executeTransition(request: GoalRequest): Promise<void> {
		const runtime = this.host.goalRuntime;
		if (request.action === "pause" || request.action === "drop") {
			if (request.action === "pause") await runtime.pauseGoal();
			else await runtime.dropGoal();
			await this.host.setGoalToolContribution(false);
			return;
		}
		const state = request.action === "enter"
			? await runtime.createGoal({ objective: request.objective, tokenBudget: request.tokenBudget })
			: await runtime.resumeGoal();
		try {
			await this.host.setGoalToolContribution(true);
			this.host.setGoalModeState(state);
		} catch (error) {
			try {
				if (request.action === "resume") await runtime.pauseGoal();
				else await runtime.dropGoal();
			} catch (compensationError) {
				throw new AggregateError([error, compensationError], "Goal activation and rollback failed", { cause: error });
			}
			throw error;
		}
	}

	async settle(): Promise<void> {
		const state = this.host.getGoalModeState();
		if (state?.goal.status === "complete" && state.mode === "exiting") {
			await this.host.setGoalToolContribution(false);
			this.host.sessionManager.appendModeChange("none");
			this.host.sessionManager.appendCustomEntry("goal-completed", {
				objective: state.goal.objective,
				tokensUsed: state.goal.tokensUsed,
				tokenBudget: state.goal.tokenBudget,
				timeUsedSeconds: state.goal.timeUsedSeconds,
			});
			this.host.setGoalModeState(undefined);
		} else {
			await this.host.setGoalToolContribution(state?.enabled === true);
		}
	}
}
