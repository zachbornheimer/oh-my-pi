import { type AgentTool, type AgentToolContext, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { StopObligationAction } from "../extensibility/shared-events";

/** Longest a hook's action may run before the host abandons it and lets the hook re-judge. */
export const STOP_OBLIGATION_ACTION_TIMEOUT_MS = 30 * 60 * 1000;

export interface StopObligationActionRequest {
	action: StopObligationAction;
	/** Extension path that raised the obligation; the tool must be registered by it. */
	issuer: string;
	/** Issuer-scoped callbacks deliberately live outside all tool registries. */
	findHandler?: (issuer: string, name: string) => ((args: Record<string, unknown>, signal: AbortSignal) => Promise<void>) | undefined;
	/** Names the extension that registered a tool, or `undefined` when none did. */
	registeredBy: (toolName: string) => string | undefined;
	/** The tool through the session's normal registry: approvals and `tool_call` hooks wrap it. */
	findTool: (toolName: string) => AgentTool | undefined;
	context: AgentToolContext | undefined;
	signal: AbortSignal;
	toolCallId: string;
}

/**
 * - `rejected`: the host refused to run it (unknown or foreign tool, invalid arguments, no context).
 * - `ran`: the tool was dispatched. `error` is set when it threw or was blocked; a result, even a
 *   successful one, is not proof: the issuing hook re-judges next.
 */
export type StopObligationActionOutcome = { kind: "rejected"; detail: string } | { kind: "ran"; error?: string };

/** Run a hook's structured repair action through the same wrapped tool path the model's own calls take. */
export async function runStopObligationAction(
	request: StopObligationActionRequest,
): Promise<StopObligationActionOutcome> {
	const { action, issuer, toolCallId } = request;
	if (typeof action.handler === "string") {
		const execute = request.findHandler?.(issuer, action.handler);
		if (!execute) return { kind: "rejected", detail: "private action is not registered by the issuing extension" };
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(STOP_OBLIGATION_ACTION_TIMEOUT_MS)]);
		try {
			await execute(action.args, signal);
			return { kind: "ran" };
		} catch (error) {
			return { kind: "ran", error: errorText(error) };
		}
	}
	if (request.registeredBy(action.tool) !== issuer) {
		return {
			kind: "rejected",
			detail: `action tool ${action.tool} is not registered by the extension that raised the obligation`,
		};
	}
	const tool = request.findTool(action.tool);
	if (!tool) return { kind: "rejected", detail: `action tool ${action.tool} is not in this session's tool registry` };
	if (!request.context) return { kind: "rejected", detail: "this session has no tool execution context" };

	let args: ToolCall["arguments"];
	try {
		args = validateAgentToolArguments(
			tool,
			{ type: "toolCall", id: toolCallId, name: tool.name, arguments: action.args },
			"payload",
		);
	} catch (error) {
		return { kind: "rejected", detail: `action arguments for ${action.tool} are invalid: ${errorText(error)}` };
	}

	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(STOP_OBLIGATION_ACTION_TIMEOUT_MS)]);
	try {
		await tool.execute(toolCallId, args, signal, undefined, request.context);
		return { kind: "ran" };
	} catch (error) {
		return { kind: "ran", error: errorText(error) };
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
