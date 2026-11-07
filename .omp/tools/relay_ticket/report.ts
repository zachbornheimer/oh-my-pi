import { type Landing, landingLine } from "./landing.js";
import type { SessionRun } from "./ports.js";
import type { RelayTicketOutput } from "./types.js";

/** The lines the session's closing reply sits between; the prompt asks for exactly these. */
export const REPLY_BEGIN = "RELAY-REPLY-BEGIN";
export const REPLY_END = "RELAY-REPLY-END";
/** How much of the session's reply the settling comment keeps (its tail): the brief tells the session to stay under it. */
export const REPLY_MAX_CHARS = 3000;

const MARKER_LINE = /^E2B-SESSION: ([a-z_]+)=(.*)$/gm;
const REPLY_BLOCK = new RegExp(`^${REPLY_BEGIN}[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*${REPLY_END}[ \\t]*$`, "gm");

/** The container-side `E2B-SESSION: key=value` markers the driver printed; the last of each key wins. */
export function sessionMarkers(output: string): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const [, key, value] of output.matchAll(MARKER_LINE)) {
    if (key !== undefined && value !== undefined) markers[key] = value.trim();
  }
  return markers;
}

const PREP_FAILED_LINE = /^E2B-SESSION: prep_failed: (.+)$/gm;

/**
 * Why the container could not prepare the session (the last `E2B-SESSION: prep_failed: <why>` line it printed), or
 * undefined when preparation did not fail. Exit 125 alone cannot say whether a download, the clone or the GitHub
 * token was the problem; this line does.
 */
export function prepFailure(output: string): string | undefined {
  return [...output.matchAll(PREP_FAILED_LINE)].at(-1)?.[1]?.trim();
}

/** What the session driver's exit code says, in its own contract's words (e2b-session.sh's exit contract). */
export function exitMeaning(run: SessionRun): string {
  if (run.stopped) return "the capability's deadline or abort stopped the driver before it ended on its own";
  switch (run.exitCode) {
    case 0:
      return "the session ended and its worktree was dropped";
    case null:
      return "the driver never started";
    case 124:
      return "the driver could not terminate the sandbox";
    case 125:
      return "driver-level failure: bad arguments, no such sandbox, missing prerequisites, or the container exit trap never ran";
    case 126:
      return "the session ended but `wt done --drop` did not succeed";
    case 129:
    case 130:
    case 143:
      return `the driver was signalled (${run.exitCode}) and tore down`;
    default:
      return `omp exited ${run.exitCode}`;
  }
}

/**
 * The session's own closing reply: the last block it printed between the reply markers, which the prompt asks for.
 * The driver prints the whole container transcript, so the drop report and git's push noise around the reply are not it.
 */
export function sessionReply(output: string): string {
  const blocks = [...output.matchAll(REPLY_BLOCK)];
  return blocks.at(-1)?.[1]?.trim().slice(-REPLY_MAX_CHARS) ?? "";
}

/** A GitHub pull request of one repository: `https://github.com/<owner>/<name>/pull/<n>`, the form `gh pr create` prints. */
function pullRequestUrlPattern(repo: string | undefined): RegExp {
  const name = repo === undefined ? "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" : repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`https://github\\.com/(${name})/pull/(\\d+)`, "gi");
}

/**
 * The pull request the session reported for this repository: the last one its reply names (the brief tells it to put
 * the pull request URL in the reply). The url is rebuilt from the repository and the number, so nothing else the reply
 * carries reaches the answer; none named is none.
 */
export function pullRequestFrom(reply: string, repo: string | undefined): { url: string; label: string } | undefined {
  const [, name, number] = [...reply.matchAll(pullRequestUrlPattern(repo))].at(-1) ?? [];
  return number === undefined ? undefined : { url: `https://github.com/${name}/pull/${number}`, label: `${name}#${number}` };
}

/** The opening progress comment: the lease, before the session's output (which the driver prints only when it ends). */
export function startedComment(run: { sandbox: string; repo?: string; branch?: string; minutes: number; model?: string }): string {
  return [
    `relay_ticket: sandbox \`${run.sandbox}\` leased; an omp session is working this ticket`
      + (run.repo === undefined
        ? "; no repository was named, so it clones what it needs itself"
        : ` on branch \`${run.branch}\` of \`${run.repo}\``)
      + ` (budget ${run.minutes} min${run.model === undefined ? "" : `, model ${run.model}`}).`,
    "The sandbox is terminated when the session ends. The session's reply is posted when it does.",
  ].join("\n");
}

/** The settling comment: the outcome, the driver's exit and markers, the sandbox's teardown, and the session's closing reply. */
export function settledComment(
  outcome: Omit<RelayTicketOutput, "settled" | "report" | "pullRequest" | "landing" | "prLanded">,
  run: SessionRun | undefined,
  landing?: Landing,
): string {
  const lines = [
    `relay_ticket: ${outcome.status}${outcome.reason === undefined ? "" : ` — ${outcome.reason}`}`,
    outcome.repo === undefined
      ? `- sandbox \`${outcome.sandbox}\`; no repository was named, so the session cloned what it needed itself`
      : `- sandbox \`${outcome.sandbox}\`, branch \`${outcome.branch}\`, repository \`${outcome.repo}\``,
    `- session exit: ${outcome.sessionExit === null ? "none" : outcome.sessionExit}${run === undefined ? "" : ` (${exitMeaning(run)})`}`,
    `- worktree dropped: ${outcome.markers.worktree_dropped ?? "unknown"} (drop exit ${outcome.markers.drop_exit ?? "none"})`,
    `- sandbox teardown: ${outcome.teardown.state}${outcome.teardown.detail === undefined ? "" : ` — ${outcome.teardown.detail}`}`,
    ...(landing === undefined ? [] : [`- ${landingLine(landing)}${landing.reasons.length === 0 ? "" : ` — ${landing.reasons.join("; ")}`}`]),
  ];
  const reply = run === undefined ? "" : sessionReply(run.output);
  lines.push("", reply === "" ? "The session left no reply block." : `Session reply:\n${reply}`);
  return lines.join("\n");
}
