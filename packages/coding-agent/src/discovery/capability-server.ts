/**
 * Capability server identity and the steering predicate for its blocking wait.
 *
 * The local `capability` CLI's MCP server (the capability-replicas runtime)
 * publishes its tools namespaced as `agentmux_capability_<name>`, and its
 * `wait` blocks up to 30 minutes settling on machine state. Steering must
 * cancel that call in flight instead of letting it run to completion
 * (at-h3cq90): the agent loop hands the steering abort only to interruptible
 * tools, and the transport turns the abort into `notifications/cancelled` for
 * the request id on the wire.
 */
export const CAPABILITY_SERVER_NAME = "capability";

/**
 * The MCP tool name the capability server serves its wait under. The real
 * server publishes its tools namespaced as `agentmux_capability_<name>`
 * (agentmux gateway `tools/list`), so the wait is not addressed as plain
 * "wait" anywhere in omp.
 */
export const CAPABILITY_WAIT_TOOL_NAME = "agentmux_capability_wait";

/** Whether `serverName`/`toolName` address the capability-native wait. */
export function isCapabilityWaitTool(serverName: string, toolName: string): boolean {
	return serverName === CAPABILITY_SERVER_NAME && toolName === CAPABILITY_WAIT_TOOL_NAME;
}

/**
 * Whether a capability-wait call blocks this turn and so must be cancellable
 * by steering. `wait` (the default; `{}` is the whole call) blocks up to 30
 * minutes; `status` is a read. `arm` and `cancel` write state and launchd
 * jobs but return at once, so killing them mid-flight gains nothing.
 */
export function isInterruptibleCapabilityWaitCall(args: unknown): boolean {
	if (args !== null && typeof args === "object" && "action" in args) {
		const action = args.action;
		return action === undefined || action === "wait" || action === "status";
	}
	return true;
}
