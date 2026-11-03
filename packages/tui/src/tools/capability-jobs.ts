/**
 * Compact background-job rows for the capability gateway's job tools —
 * `agentmux_capability_wait` and `agentmux_capability_run_command` — which the
 * MCP bridge renders through {@link renderCapabilityJobResult} and
 * {@link describeCapabilityJobResult} instead of the generic MCP card. A
 * settled wait and a background dispatch are each one transcript status row;
 * a foreground command and every structured winner the rows do not cover keep
 * the MCP card (the bridge falls back to it when these return `undefined`).
 */
import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";
import { span } from "../native/describe";
import { buildBackgroundJobRow } from "../chat/transcript-render-helpers";
import { markFramedBlockComponent } from "../render/output-block";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme";
import { TranscriptStatusBlock, type TranscriptStatusRow } from "../chrome/transcript-status";
import type { Component } from "../tui";
import type { NativeToolView } from "./renderer";

/** Server name of the capability gateway. */
export const CAPABILITY_SERVER_NAME = "capability";
/** Gateway tool that blocks on background work. */
export const CAPABILITY_WAIT_TOOL_NAME = "agentmux_capability_wait";
/** Gateway tool that runs a shell command, foregrounded or backgrounded. */
export const CAPABILITY_RUN_COMMAND_TOOL_NAME = "agentmux_capability_run_command";

/**
 * Minted registry names of the gateway's job tools — `createMCPToolName` joins
 * the sanitized server and tool name with a single underscore. The transcript
 * only ever sees minted names, so they are declared beside the views that match
 * them; `isWaitLikeToolName` reuses the wait one.
 */
export const MCP_CAPABILITY_WAIT_TOOL_NAME = `mcp__${CAPABILITY_SERVER_NAME}_${CAPABILITY_WAIT_TOOL_NAME}`;
export const MCP_CAPABILITY_RUN_COMMAND_TOOL_NAME = `mcp__${CAPABILITY_SERVER_NAME}_${CAPABILITY_RUN_COMMAND_TOOL_NAME}`;

/** Whether the server/tool pair is the gateway's wait tool. */
export function isCapabilityWaitToolName(serverName: string, toolName: string): boolean {
	return serverName === CAPABILITY_SERVER_NAME && toolName === CAPABILITY_WAIT_TOOL_NAME;
}

/** Whether the server/tool pair is the gateway's command tool. */
export function isCapabilityRunCommandToolName(serverName: string, toolName: string): boolean {
	return serverName === CAPABILITY_SERVER_NAME && toolName === CAPABILITY_RUN_COMMAND_TOOL_NAME;
}

/** Whether the server/tool pair is either of the gateway's row-rendered job tools. */
export function isCapabilityJobTool(serverName: string, toolName: string): boolean {
	return isCapabilityWaitToolName(serverName, toolName) || isCapabilityRunCommandToolName(serverName, toolName);
}

/**
 * Wait-like tool names: the built-in `wait` and the gateway's minted wait.
 * Steering skips, benign-skip hiding and repeated all-running polls treat
 * both alike in the transcript.
 */
export function isWaitLikeToolName(name: string): boolean {
	return name === "wait" || name === MCP_CAPABILITY_WAIT_TOOL_NAME;
}

/** The gateway's JSON envelope: text content parsed to its `output` record, or `undefined`. */
function capabilityOutput(result: {
	content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> | undefined {
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.filter(text => text.length > 0)
		.join("\n\n")
		.trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) && isRecord(parsed.output) ? parsed.output : undefined;
	} catch {
		return undefined;
	}
}

/** Dispatched-command preview budget in characters (the /tan preview idiom). */
const COMMAND_PREVIEW_CHARS = 56;

/** First line of a dispatched command, collapsed and shortened for the row. */
function previewCommand(command: unknown): string | undefined {
	if (typeof command !== "string") return undefined;
	const singleLine = replaceTabs(command).trim().replace(/\s+/g, " ");
	if (!singleLine) return undefined;
	return singleLine.length <= COMMAND_PREVIEW_CHARS
		? singleLine
		: `${singleLine.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`;
}

/** A settled job failed when its state is not a success state or its exit code is non-zero. */
function jobEndedInFailure(state: string | undefined, exitCode: number | undefined): boolean {
	if (exitCode !== undefined && exitCode !== 0) return true;
	return state !== undefined && state !== "exited" && state !== "completed";
}

/** The wait row: one line per wait outcome, or `undefined` when the MCP card keeps it. */
function capabilityWaitRow(output: Record<string, unknown>): TranscriptStatusRow | undefined {
	const status = output.status;
	if (status === "nothing_to_wait_for") {
		return {
			parts: [{ text: "· Nothing to wait for", color: "muted" }],
			native: { tone: "info", message: [span("Nothing to wait for", "dim")] },
		};
	}
	if (status === "timed_out") {
		const elapsed = typeof output.elapsed_ms === "number" ? formatDuration(output.elapsed_ms) : undefined;
		return {
			parts: [
				{ text: "· Wait timed out", color: "muted" },
				elapsed ? { text: `(${elapsed})`, color: "dim" } : undefined,
				{ text: `${theme.format.dash} the work is still running`, color: "dim" },
			],
			native: {
				tone: "info",
				message: [
					span("Wait timed out", "dim"),
					...(elapsed ? [span(` (${elapsed})`, "dim")] : []),
					span(` ${theme.format.dash} the work is still running`, "dim"),
				],
			},
		};
	}
	if (status !== "settled") return undefined;
	const job = output.job;
	if (isRecord(job)) {
		const jobId = typeof job.job_id === "string" ? job.job_id : undefined;
		if (!jobId) return undefined;
		const state = typeof job.state === "string" ? job.state : undefined;
		const exitCode = typeof job.exit_code === "number" ? job.exit_code : undefined;
		return buildBackgroundJobRow({ jobId, exitCode, failed: jobEndedInFailure(state, exitCode) });
	}
	// A queued completion: `about` carries the settled job's facts; the subject,
	// body and pending count stay off the row (the agent waits again for them).
	const completion = output.completion;
	if (isRecord(completion)) {
		const about = isRecord(completion.about) ? completion.about : undefined;
		const id = typeof about?.id === "string" ? about.id : undefined;
		if (!about || !id) return undefined;
		const type = typeof about.type === "string" && about.type ? about.type : undefined;
		const state = typeof about.state === "string" ? about.state : undefined;
		const exitCode = typeof about.exit_code === "number" ? about.exit_code : undefined;
		return buildBackgroundJobRow({ type, jobId: id, exitCode, failed: jobEndedInFailure(state, exitCode) });
	}
	const task = output.task;
	if (isRecord(task)) {
		const id = typeof task.id === "string" ? task.id : undefined;
		const title = typeof task.title === "string" ? task.title : undefined;
		if (!id || !title) return undefined;
		return buildBackgroundJobRow({ type: "task", jobId: title });
	}
	// An arm that fired, or a record batch: structured output stays on the MCP card.
	return undefined;
}

/** The background-dispatch row; a foreground command keeps the MCP card. */
function capabilityRunCommandRow(
	output: Record<string, unknown> | undefined,
	args: Record<string, unknown>,
): TranscriptStatusRow | undefined {
	if (!args.background) return undefined;
	const jobId = isRecord(output) && typeof output.jobId === "string" ? output.jobId : undefined;
	if (!jobId) return undefined;
	const command = previewCommand(args.command);
	return {
		parts: [
			{ text: `${theme.status.done} Backgrounded as job`, color: "success" },
			{ text: jobId, color: "accent" },
			command ? { text: `${theme.format.dash} ${command}`, color: "dim" } : undefined,
		],
		native: {
			tone: "success",
			icon: "job",
			message: [
				span("Backgrounded as job"),
				span(" "),
				span(jobId, "accent"),
				...(command ? [span(" "), span(`${theme.format.dash} ${command}`, "dim")] : []),
			],
		},
	};
}

/** The capability row for a result, or `undefined` when the MCP card keeps it. */
function capabilityJobRow(
	mcpToolName: string,
	result: { content: Array<{ type: string; text?: string }> },
	args: Record<string, unknown>,
): TranscriptStatusRow | undefined {
	if (mcpToolName === CAPABILITY_WAIT_TOOL_NAME) {
		const output = capabilityOutput(result);
		return output ? capabilityWaitRow(output) : undefined;
	}
	if (mcpToolName === CAPABILITY_RUN_COMMAND_TOOL_NAME) {
		return capabilityRunCommandRow(capabilityOutput(result), args);
	}
	return undefined;
}

/**
 * The ANSI view of a capability job result: the row as a framed transcript
 * status block, or `undefined` when the MCP card keeps it (foreground command,
 * structured winner, malformed payload). Never throws: the bridge falls back
 * to the MCP card.
 */
export function renderCapabilityJobResult(
	mcpToolName: string,
	result: { content: Array<{ type: string; text?: string }> },
	args: Record<string, unknown>,
): Component | undefined {
	try {
		const row = capabilityJobRow(mcpToolName, result, args);
		return row ? markFramedBlockComponent(new TranscriptStatusBlock([row])) : undefined;
	} catch {
		return undefined;
	}
}

/** The native view of {@link renderCapabilityJobResult}: the same row inline. */
export function describeCapabilityJobResult(
	mcpToolName: string,
	result: { content: Array<{ type: string; text?: string }> },
	args: Record<string, unknown>,
): NativeToolView | undefined {
	try {
		const row = capabilityJobRow(mcpToolName, result, args);
		return row ? { head: row.native.message, inline: true, tone: row.native.tone } : undefined;
	} catch {
		return undefined;
	}
}
