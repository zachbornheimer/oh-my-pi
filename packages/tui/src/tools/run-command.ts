/**
 * The card for the capability gateway's shell tool, `run_command`.
 *
 * The tool runs on omp's own shell contract — args `command`/`purpose`/`cwd`, result
 * `status`/`exit_code`/`body` — but it is reached over MCP, so the gateway names it
 * `agentmux_capability_run_command` and the harness stores its result as a gateway envelope:
 * `{ capability: "run_command", output: { … } }`. The generic MCP card drew that envelope as a JSON
 * tree — `capability`, `output`, `status`, `exit_code`, `body` — where a run shows its command and
 * the command's output.
 *
 * So this module is the view that envelope deserves. The call *is* a run, so it renders with the
 * shell card — `createShellRenderer`, the same one `bash` builds — after unwrapping the envelope:
 * the head is the command, the body is the command's own output, the foot is its exit code.
 * `capability-jobs.ts` owns which gateway tools use it.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { Component } from "../tui";
import { type BashToolDetails, createShellRenderer } from "./bash";
import type { MCPToolDetails } from "./mcp";
import type { NativeToolView, RenderResultContextOptions, ToolRenderer, ToolRenderResult } from "./renderer";

/** One command's own result, lifted out of the gateway's envelope. */
export interface CapabilityRunCommandOutput {
	status?: string;
	exit_code?: number;
	/** Absent on a call that was promoted while its command was still running. */
	body?: string;
	/** Why the call never ran a command (`denied`, `error`). */
	reason?: string;
	jobId?: string;
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(source: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

/**
 * The gateway's result envelope: the capability's own `output`, and the call's usage beside it. Anything
 * else — a payload that merely ends in `run_command` — is not one, and gets no shell card.
 */
function envelopeOf(value: unknown): CapabilityRunCommandOutput | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const envelope = value as Record<string, unknown>;
	if (envelope.capability !== "run_command") return undefined;
	const output = envelope.output;
	if (typeof output !== "object" || output === null) return undefined;
	const fields = output as Record<string, unknown>;
	return {
		status: textOf(fields.status),
		exit_code: numberField(fields, "exit_code", "exitCode"),
		// `""` is a command that printed nothing; only an absent `body` marks a promoted call.
		body: typeof fields.body === "string" ? fields.body : undefined,
		reason: textOf(fields.reason),
		jobId: textOf(fields.jobId),
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * The command's own result inside an MCP result: the server's structured payload when it sent one, else
 * the JSON envelope the gateway renders as the model-facing text. Undefined when the result is not a
 * gateway envelope, which leaves the caller free to draw its own view.
 */
export function capabilityRunCommandOutput(result: {
	content?: Array<{ type: string; text?: string }>;
	details?: MCPToolDetails;
}): CapabilityRunCommandOutput | undefined {
	const structured = envelopeOf(result.details?.structuredContent);
	if (structured !== undefined) return structured;
	const text = result.content?.find(part => part.type === "text")?.text;
	return text === undefined ? undefined : envelopeOf(parseJson(text));
}

/** Reads one string arg off the model's call. */
function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	return args === undefined ? undefined : textOf(args[key]);
}

const shell = createShellRenderer<Record<string, unknown>>({
	resolveTitle: () => "Run",
	resolveCommand: args => stringArg(args, "command"),
	resolveCwd: args => stringArg(args, "cwd"),
	showHeader: false,
});

/**
 * The call's args with the head's intent line filled in. The gateway spells omp's intent field `purpose` —
 * "one sentence, what you want to learn from the command" — so a call shows the same line a native run does.
 */
function withIntent(args: Record<string, unknown> | undefined): Record<string, unknown> {
	if (args === undefined) return {};
	const purpose = stringArg(args, "purpose");
	if (purpose === undefined || args[INTENT_FIELD] !== undefined) return args;
	return { ...args, [INTENT_FIELD]: purpose };
}

/**
 * The shell card's inputs for one gateway call: the command's own output as the body, its exit code and
 * timeout as the run's facts.
 */
function asShellResult(result: ToolRenderResult<MCPToolDetails>): ToolRenderResult<BashToolDetails> | undefined {
	const output = capabilityRunCommandOutput(result);
	if (output === undefined) return undefined;
	const details: BashToolDetails = {};
	if (typeof output.exit_code === "number") details.exitCode = output.exit_code;
	if (output.status === "timeout") details.timedOut = true;
	// A promoted call carries `jobId` and no body — a finished one carries both — so only the missing body
	// makes it a job in the foot.
	if (output.jobId !== undefined && output.body === undefined) {
		details.async = { state: "running", jobId: output.jobId, type: "bash" };
	}
	return {
		content: [{ type: "text", text: output.body ?? output.reason ?? "" }],
		details,
		isError: result.isError,
	};
}

/**
 * The gateway shell's card. Every hook answers `undefined` when the payload is not the gateway's
 * envelope, which leaves the caller free to draw the MCP card for that result.
 */
export const capabilityRunCommandRenderer: ToolRenderer<Record<string, unknown>, MCPToolDetails> = {
	renderCall(args, options, theme): Component | undefined {
		return shell.renderCall(withIntent(args), options, theme);
	},
	renderResult(result, options, theme, args): Component | undefined {
		const unwrapped = asShellResult(result);
		if (unwrapped === undefined) return undefined;
		return shell.renderResult(unwrapped, options as RenderResultContextOptions, theme, withIntent(args));
	},
	describeCall(args, options): NativeToolView | undefined {
		return shell.describeCall?.(withIntent(args), options);
	},
	describeResult(result, options, args): NativeToolView | undefined {
		const unwrapped = asShellResult(result);
		if (unwrapped === undefined) return undefined;
		return shell.describeResult?.(unwrapped, options, withIntent(args));
	},
	mergeCallAndResult: true,
	inline: true,
	tickElapsed: true,
};
