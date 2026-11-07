import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { CHECKPOINT_DIR, HEARTBEAT_MS } from "./constants.js";
import type { FactoryPorts } from "./ports.js";
import { TICKET_PATTERN } from "./schemas.js";
import { runTicket, type RunResult } from "./workflow.js";
import { knownTeams } from "./workspaces.js";

const DESCRIPTION =
  `Work one Linear ticket of a workspace the factory knows (${knownTeams()}) end to end, one ticket at a time on this machine; \`software_factory\` sweeps and works the next tickets instead. `
  + "Input `{\"ticket\":\"ZYS-45\",\"merge\":false}`: the prefix names the workspace, its statuses and checkout roots; `merge` (default false) lets a settled pull request be landed. "
  + "Steps: lock; read the ticket and its linked PRs; /tickets analysis (writes nothing; an undecipherable ticket goes to the not-ready status with its questions); find the repository, or work the ticket without a checkout; worktree; adversarial root-cause review (already done, obsolete, superseded close the ticket and its linked PRs; needs info remands); omp implements; adversarial diff review (one fix round, never a third); push and open a ready PR (a draft when information is missing); fix_red_ci; Linear status and comment; landing when `merge`. "
  + "Every Linear write is read back. A held machine-wide lock returns `busy` naming the holder and touches nothing. "
  + `Every finished step is checkpointed in ${CHECKPOINT_DIR}/<TICKET>.json: a rerun within 24 h of an unfinished run skips the steps it lists; cancelling keeps the file. A failed run leaves one comment on the ticket. `
  + "Needs a Linear key per workspace (`LINEAR_API_KEY_<TEAM>`, `LINEAR_API_KEY`, or the Keychain), `gh`, `git` and `omp`; landing, CI repair and dependency upgrades call the `make_pr_mergable`, `fix_red_ci` and `upgrade_dependency` tools through a relay omp session and fail naming one that is not installed. "
  + "Mutates Linear, GitHub (pushes, PRs, merges) and the checkouts, and spends model quota for up to hours; sends progress updates. "
  + "Returns `outcome` (undecipherable | blocked | needs_info | already_done | obsolete | superseded | work_completed | pr_ready | busy), `linearStatus`, `pullRequest`, `closedPullRequests`, `landing`, `prLanded`, `busyHeldBy` and `skippedSteps`.";

export function resultText(result: RunResult): string {
  const { state } = result;
  const lines = [
    `${state.ticket}: ${state.outcome ?? "no outcome"}${state.linearStatus === undefined ? "" : `, Linear status ${state.linearStatus}`}`,
    ...(state.outcome === "busy" && state.busyHeldBy !== undefined
      ? [`The factory lock is held by run ${state.busyHeldBy.runId} on ${state.busyHeldBy.ticket}; nothing was touched.`]
      : []),
    ...(state.closing === undefined ? [] : [state.closing.summary]),
    ...(state.pullRequest === undefined ? [] : [`Pull request: ${state.pullRequest.url}${state.pullRequest.draft ? " (draft)" : ""}`]),
    ...(state.closedPullRequests.length === 0 ? [] : [`Closed pull requests: ${state.closedPullRequests.join(", ")}`]),
    ...(state.landing === undefined
      ? []
      : [`Landing: ${state.landing.state} via ${state.landing.route} (${state.landing.landed ? "landed" : "not landed"})`]),
    ...(result.resumed ? [`Resumed from a checkpoint; skipped: ${result.skipped.join(", ") || "none"}`] : []),
  ];
  return lines.join("\n");
}

export function resultDetails(result: RunResult, seconds: number): Record<string, unknown> {
  const { state } = result;
  return {
    ticket: state.ticket,
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
    ...(state.linearStatus === undefined ? {} : { linearStatus: state.linearStatus }),
    ...(state.pullRequest === undefined ? {} : { pullRequest: state.pullRequest }),
    closedPullRequests: state.closedPullRequests,
    ...(state.busyHeldBy === undefined ? {} : { busyHeldBy: state.busyHeldBy }),
    ...(state.landing === undefined ? {} : { landing: state.landing }),
    ...(state.prLanded === undefined ? {} : { prLanded: state.prLanded }),
    rounds: state.rounds,
    resumed: result.resumed,
    skippedSteps: result.skipped,
    seconds,
  };
}

/** The tool over the ports `makePorts` builds for one call; `index.ts` passes the real ones, a test its own and a short heartbeat. */
export function ticketTool(
  makePorts: (signal: AbortSignal | undefined) => FactoryPorts,
  heartbeatMs: number = HEARTBEAT_MS,
): CustomToolFactory {
  return (pi) => ({
    name: "software_factory_ticket",
    label: "Software factory ticket",
    description: DESCRIPTION,
    parameters: pi.zod.object({
      ticket: pi.zod.string().regex(TICKET_PATTERN, `A Linear ticket identifier such as ${knownTeams().split(", ").map((team) => `${team}-123`).join(" or ")}.`)
        .describe(`Linear ticket, such as ZYS-45; its prefix names the workspace (${knownTeams()}).`),
      merge: pi.zod.boolean().nullable().optional().describe("Land the pull request once it is settled approved (a dependency bot's through upgrade_dependency, any other through make_pr_mergable). Default false: it is only driven to settled."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `software_factory_ticket: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, heartbeatMs);
      try {
        const result = await runTicket(makePorts(signal), { ticket: params.ticket, merge: params.merge ?? false }, {
          ...(signal === undefined ? {} : { signal }),
          progress: (message) => {
            phase = message;
          },
        });
        return {
          content: [{ type: "text", text: resultText(result) }],
          details: resultDetails(result, Math.round((Date.now() - began) / 1000)),
        };
      } finally {
        clearInterval(beat);
      }
    },
  });
}
