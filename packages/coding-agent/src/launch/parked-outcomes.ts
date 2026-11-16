/** Outcomes of parked tool calls whose detached daemon the broker has finished running. */
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { ParkedJobOutcome, ParkedToolCall } from "../session/exit-diagnostics";
import { daemonClientForProject } from "./client";

/** Longest log tail returned to the model; the broker log holds the rest. */
const MAX_OUTCOME_CHARS = 64 * 1024;

/**
 * For each parked call whose daemon (named by its `jobId`) reached a terminal state, the
 * output tail and whether it failed. A daemon still running, or one the broker no longer
 * knows, is absent from the result, so its call stays parked.
 */
export async function settledParkedOutcomes(
	cwd: string,
	calls: readonly ParkedToolCall[],
	signal?: AbortSignal,
): Promise<Map<string, ParkedJobOutcome>> {
	const settled = new Map<string, ParkedJobOutcome>();
	if (calls.length === 0) return settled;
	const client = await daemonClientForProject(cwd);
	const listed = await client.request({ op: "list" }, signal);
	if (listed.op !== "list") throw new Error("Unexpected daemon list response");
	for (const call of calls) {
		const daemon = listed.daemons.find(candidate => candidate.name === call.jobId);
		if (!daemon || !TERMINAL_STATES[daemon.state]) continue;
		const logs = await client.request(
			{ op: "logs", name: call.jobId, lines: 1_000, head: false, follow: false, timeoutMs: 1_000 },
			signal,
		);
		if (logs.op !== "logs") throw new Error("Unexpected daemon logs response");
		const output = logs.text.length > MAX_OUTCOME_CHARS ? logs.text.slice(-MAX_OUTCOME_CHARS) : logs.text;
		const failed = daemon.exitReason !== undefined || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
		const exit =
			daemon.exitReason !== undefined
				? `[${daemon.exitReason}]`
				: daemon.exitCode === undefined
					? ""
					: `[exit code ${daemon.exitCode}]`;
		// The exit line is the part the model must not lose, so it is added after the tail is cut.
		settled.set(call.jobId, { text: exit ? `${output}\n${exit}` : output, isError: failed });
	}
	return settled;
}
