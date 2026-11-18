/** Outcomes of parked tool calls whose detached daemon the broker has finished running. */
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import { canonicalProjectDir, daemonClient } from "../daemon/client";
import { projectScope } from "../daemon/protocol";
import type { ParkedJobOutcome, ParkedToolCall } from "../session/exit-diagnostics";
import { claimBrokerOutcome } from "../tools/job-owner";

/** Longest log tail returned to the model; the daemon log holds the rest. */
const MAX_OUTCOME_CHARS = 64 * 1024;

/**
 * For each parked call whose service (named by its `jobId`) reached a terminal state, the
 * output tail and whether it failed. A service still running, or one the daemon no longer
 * knows, is absent from the result, so its call stays parked.
 */
export async function settledParkedOutcomes(
	cwd: string,
	calls: readonly ParkedToolCall[],
	signal?: AbortSignal,
): Promise<Map<string, ParkedJobOutcome>> {
	const settled = new Map<string, ParkedJobOutcome>();
	if (calls.length === 0) return settled;
	for (const call of calls) {
		if (!call.jobId.startsWith("/")) continue;
		const outcome = await claimBrokerOutcome(call.jobId);
		if (outcome) settled.set(call.jobId, outcome);
	}
	if (calls.every(call => call.jobId.startsWith("/"))) return settled;
	const client = await daemonClient();
	const scope = projectScope(await canonicalProjectDir(cwd));
	const listed = await client.request({ op: "list", scope, kind: "proc" }, signal);
	for (const call of calls) {
		const unit = listed.units.find(candidate => candidate.key === call.jobId);
		if (!unit || !TERMINAL_STATES[unit.state]) continue;
		const logs = await client.request(
			{ op: "logs", unit: unit.id, lines: 1_000, head: false, follow: false, timeoutMs: 1_000 },
			signal,
		);
		const output = logs.text.length > MAX_OUTCOME_CHARS ? logs.text.slice(-MAX_OUTCOME_CHARS) : logs.text;
		const failed = unit.exitReason !== undefined || (unit.exitCode !== undefined && unit.exitCode !== 0);
		const exit =
			unit.exitReason !== undefined
				? `[${unit.exitReason}]`
				: unit.exitCode === undefined
					? ""
					: `[exit code ${unit.exitCode}]`;
		// The exit line is the part the model must not lose, so it is added after the tail is cut.
		settled.set(call.jobId, { text: exit ? `${output}\n${exit}` : output, isError: failed });
	}
	return settled;
}
