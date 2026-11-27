import type {
	ExtensionSessionModes,
	SessionModeRequest,
	SessionModeResult,
	SessionModeState,
} from "../extensibility/extensions/types";

export interface GoalModeControl {
	readState(): SessionModeState;
	requestFromExtension(request: Extract<SessionModeRequest, { mode: "goal" }>): Promise<SessionModeResult>;
}

/** Headless hosts expose goal control, not interactive mode machinery. */
export function createHeadlessSessionModes(control: GoalModeControl): ExtensionSessionModes {
	return {
		getState: () => control.readState(),
		async set(request) {
			if (request.mode !== "goal") {
				return {
					ok: false,
					code: "invalid_request",
					message: "Only goal mode is available in this headless host.",
					state: control.readState(),
				};
			}
			return control.requestFromExtension(request);
		},
	};
}
