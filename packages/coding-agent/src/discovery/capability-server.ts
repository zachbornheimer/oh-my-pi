/**
 * Capability tool naming, display, and wait-steering helpers.
 *
 * MCP servers are configured through user/project MCP config (targeting the
 * centralized `mcp-gateway`), not discovered via a local `capability` CLI
 * lookup on PATH.
 */

/** Legacy capability server namespace used by tool-bridge and wait helpers. */
export const CAPABILITY_SERVER_NAME = "capability";

/**
 * The MCP tool name the capability wait is addressed under (`agentmux_capability_wait`).
 */
export const CAPABILITY_WAIT_TOOL_NAME = "agentmux_capability_wait";

/** Whether `serverName`/`toolName` address the capability-native wait. */
export function isCapabilityWaitTool(serverName: string, toolName: string): boolean {
	return serverName === CAPABILITY_SERVER_NAME && toolName === CAPABILITY_WAIT_TOOL_NAME;
}

/** The capability gateway's generic dispatcher: runs the tool named by `args.address`. */
export const CAPABILITY_TOOL_CALL_TOOL_NAME = "tool_call";

/** Whether `serverName` addresses the capability gateway. */
export function isCapabilityTool(serverName: string): boolean {
	return serverName === CAPABILITY_SERVER_NAME;
}

/** The prefix the gateway repeats inside its tool names (`agentmux_capability_read`). */
const CAPABILITY_TOOL_NAME_PREFIX = "agentmux_capability_";

/**
 * Display title for a capability-gateway tool: one leading `agentmux_capability_`
 * (the server name already says "capability") is stripped; anything else is kept.
 */
export function capabilityToolDisplayName(toolName: string): string {
	return toolName.startsWith(CAPABILITY_TOOL_NAME_PREFIX)
		? toolName.slice(CAPABILITY_TOOL_NAME_PREFIX.length)
		: toolName;
}

/**
 * Display facts for a capability `tool_call`: the title is the addressed tool
 * (last `/`-separated segment of `args.address`) and the arguments are the
 * addressed tool's own `args.args` when it is a record, otherwise the outer args
 * minus `address`. `undefined` when there is no usable address.
 */
export function capabilityToolCallDisplay(args: unknown): { label: string; args: Record<string, unknown> } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const address = record.address;
	if (typeof address !== "string" || address === "") return undefined;
	const label = address.split("/").pop();
	if (!label) return undefined;
	const inner = record.args;
	const displayArgs = inner && typeof inner === "object" ? (inner as Record<string, unknown>) : omitAddress(record);
	return { label, args: displayArgs };
}

/** The outer args minus `address`, for a dispatcher call without an `args` record. */
function omitAddress(record: Record<string, unknown>): Record<string, unknown> {
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== "address") rest[key] = value;
	}
	return rest;
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
