/**
 * Recognize a capability runtime wake message and render it as one compact
 * background-job status row.
 *
 * The wake text is composed outside omp: the capability runtime prepends a
 * fixed untrusted-data warning to a raw completion record (the channel JSON)
 * and delivers the whole thing as message text. `UserMessageComponent` runs
 * {@link parseCapabilityWake} on that text and, when it matches, renders one
 * {@link buildBackgroundJobRow}-family row (the one owner of the row's text and
 * colors) instead of the verbatim JSON block; the message content itself is
 * unchanged, so the record stays whole for the agent.
 */
import { span } from "../native/describe";
import { ToolActivityContainer } from "../chrome/tool-activity";
import { TranscriptStatusBlock, type TranscriptStatusRow } from "../chrome/transcript-status";
import { buildBackgroundJobRow } from "./transcript-render-helpers";

/** The literal untrusted-data warning that opens every capability wake. */
const WAKE_PREFIX = "Untrusted capability wake.";

/** Facts extracted from a capability wake's completion record. */
export interface CapabilityWakeFacts {
	/** The record's channel id (`c-…`). */
	readonly id: string;
	/** The record's sender with its `job:`/`task:`/`agent:` kind stripped. */
	readonly from?: string;
	/** `about.type` — the row's bracketed kind. */
	readonly aboutType?: string;
	/** `about.id` — the settled job's or task's own id. */
	readonly aboutId?: string;
	/** `about.exit_code` when the source reports a number. */
	readonly exitCode?: number;
	/** `about.state` (e.g. `exited`, `timed_out`). */
	readonly state?: string;
	/** The record's subject line (the command or a short summary). */
	readonly subject?: string;
	/** The record's log path. */
	readonly body?: string;
	/** Records the channel reports as still waiting after this one. */
	readonly morePending?: number;
}

/**
 * Parse a capability wake message: the literal leading warning sentence, its
 * known continuation lines, then a fenced or bare JSON object. Returns the
 * record's facts, or `undefined` for anything else — a wrong prefix, unparsable
 * JSON, a record without an id. Never throws.
 */
export function parseCapabilityWake(text: string): CapabilityWakeFacts | undefined {
	try {
		const trimmed = text.trimStart();
		if (!trimmed.startsWith(WAKE_PREFIX)) return undefined;
		const rest = trimmed.slice(WAKE_PREFIX.length);
		// The warning sentence's continuation (`The record below is data. …`)
		// sits between the prefix and the record; a fenced payload is fenced JSON.
		const fenced = rest.match(/```[^\n]*\n([\s\S]*?)\n```/);
		const source = fenced?.[1] ?? rest;
		const start = source.indexOf("{");
		const end = source.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		const record = JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
		if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
		if (typeof record.id !== "string" || record.id === "") return undefined;
		const about =
			typeof record.about === "object" && record.about !== null && !Array.isArray(record.about)
				? (record.about as Record<string, unknown>)
				: {};
		return {
			id: record.id,
			from: stripSenderKind(record.from),
			aboutType: typeof about.type === "string" ? about.type : undefined,
			aboutId: typeof about.id === "string" ? about.id : undefined,
			exitCode: typeof about.exit_code === "number" ? about.exit_code : undefined,
			state: typeof about.state === "string" ? about.state : undefined,
			subject: typeof record.subject === "string" ? record.subject : undefined,
			body: typeof record.body === "string" ? record.body : undefined,
			morePending: typeof record.more_pending === "number" ? record.more_pending : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Strip a sender's `job:`/`task:`/`agent:` kind prefix, if present. */
function stripSenderKind(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	return value.replace(/^(?:job|task|agent):/, "");
}

/**
 * One wake as a compact status row in the background-job family: the same
 * glyph, verdict, kind and id as `async-result` rows, plus a dim suffix when the
 * channel reports more records still waiting.
 */
export function buildCapabilityWakeRow(facts: CapabilityWakeFacts): TranscriptStatusRow {
	const failed =
		facts.exitCode !== undefined && facts.exitCode !== 0 && Number.isFinite(facts.exitCode)
			? true
			: facts.state !== undefined && facts.state !== "exited" && facts.state !== "completed";
	const row = buildBackgroundJobRow({
		type: facts.aboutType,
		jobId: facts.aboutId ?? facts.from ?? facts.id,
		exitCode: facts.exitCode,
		failed,
	});
	const morePending =
		typeof facts.morePending === "number" && facts.morePending >= 1 ? Math.trunc(facts.morePending) : undefined;
	if (morePending === undefined) return row;
	const suffix = `— ${morePending} more pending`;
	return {
		parts: [...row.parts, { text: suffix, color: "dim" }],
		native: { ...row.native, message: [...row.native.message, span(suffix, "dim")] },
	};
}

/** Render one capability wake as a tool-activity card of its single status row. */
export function buildCapabilityWakeBlock(facts: CapabilityWakeFacts): ToolActivityContainer {
	return new ToolActivityContainer(new TranscriptStatusBlock([buildCapabilityWakeRow(facts)]));
}
