/**
 * Capability Server Provider
 *
 * Registers the local `capability` MCP server (the capability-replicas
 * runtime) as a built-in default at the lowest priority: a same-named entry
 * in any user/project config wins, and the user-level `disabledServers` list
 * can switch it off. Machines without the CLI contribute nothing.
 *
 * The server fronts the capability-native `wait` that replaces omp's built-in
 * wait (design: capability-replicas
 * docs/design/2026-10-24-wait-and-run-command-backgrounding-design.md). Its
 * blocking wait settles on machine-state channels and runs up to 30 minutes,
 * so the registration disables the per-request deadline (`timeout: 0`): omp's
 * 30 s default (mcp/timeout.ts DEFAULT_MCP_TIMEOUT_MS) would kill the wait and
 * never let a long command reach auto-background. The default ships in code —
 * nothing in a user's MCP config needs hand-editing.
 */
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { mcpCapability, type MCPServer } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta } from "./helpers";

/** Server name the built-in registration owns. */
export const CAPABILITY_SERVER_NAME = "capability";
/** The capability CLI's name on PATH. */
const CAPABILITY_SERVER_COMMAND = "capability";
const PROVIDER_ID = "capability-native";
const DISPLAY_NAME = "Capability Server";
// Lowest priority: every other MCP provider wins a name conflict.
const PRIORITY = 1;

/**
 * The real lookup. Test runs never see the machine's CLI, so suites that run
 * MCP discovery do not spawn a real capability server; tests that need it
 * inject a resolver.
 */
function lookupCapabilityCommand(): string | null {
	return isBunTestRuntime() ? null : Bun.which(CAPABILITY_SERVER_COMMAND);
}

/** Resolves the capability CLI; overridable so tests can fake availability. */
let resolveCapabilityCommand: () => string | null = lookupCapabilityCommand;

/** Test seam for the binary lookup. */
export function setCapabilityCommandResolverForTests(resolver?: () => string | null): void {
	resolveCapabilityCommand = resolver ?? lookupCapabilityCommand;
}

/** Whether the local capability CLI exists on this machine. */
export function isCapabilityServerAvailable(): boolean {
	return resolveCapabilityCommand() !== null;
}

/**
 * The MCP tool name the capability server serves its wait under. The real
 * server publishes its tools namespaced as `agentmux_capability_<name>`
 * (snapshot: test/fixtures/capability-tools-list.jsonl, asserted by a
 * contract test), so the wait is not addressed as plain "wait" anywhere in
 * omp: steering, wait detection and the loop-guard exemption all flow from
 * this one constant.
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

async function loadServers(_ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	if (!isCapabilityServerAvailable()) return { items: [] };
	const source = createSourceMeta(PROVIDER_ID, `${PROVIDER_ID}:${CAPABILITY_SERVER_NAME}`, "user");
	return {
		items: [
			{
				name: CAPABILITY_SERVER_NAME,
				command: CAPABILITY_SERVER_COMMAND,
				args: ["mcp"],
				transport: "stdio",
				// 0 disables the per-request deadline; the wait's 30-minute cap is
				// the server's own.
				timeout: 0,
				enabled: true,
				_source: source,
			},
		],
	};
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Built-in capability MCP server (capability wait and friends) with the request timeout disabled",
	priority: PRIORITY,
	load: loadServers,
});
