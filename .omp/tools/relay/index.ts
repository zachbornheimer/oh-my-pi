import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { Exec } from "./exec.js";
import { liveRelayPorts, toolingCheckout } from "./live_ports.js";
import { messageOf } from "./texts.js";
import type { State } from "./types.js";
import { runRelay } from "./workflow.js";
import { TICKET_PATTERN } from "./workspaces.js";

const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Work one Linear ticket end to end and settle it, in order, none skippable: analyze, work, improve the tooling, green the pull requests, settle. "
  + "Input `{\"ticket\":\"ZYS-123\"}` (or `SAH-123`): the prefix names the Linear workspace and its status names; any other prefix is refused. "
  + "Use to own a ticket from reading to closing; NEVER for just reading a ticket, for one pull request (make_pr_mergable), or to rewrite a ticket (nothing it rewrites is saved). "
  + "(1) Reads the ticket, runs the /tickets rewrite, then a read-only adversarial root-cause review on another model family; an undecipherable ticket or a verdict other than `real` settles it and ends the run. "
  + "(2) A headless omp worker gets the rewritten ticket as untrusted data and answers a record with evidence; a blocked attempt stays blocked. "
  + "(3) A headless omp call in the tooling checkout (`RELAY_TOOLING_CHECKOUT`, default `~/Developer/Personal/capability-replicas`) lands a missing tool or changes nothing; never retried. "
  + "(4) Each PR touched gets a red-CI pass: up to 3 fix rounds pushed to its branch; failed checks only, not review threads or conflicts; a PR still red settles the run blocked. "
  + "(5) Sets the Linear status and comments, each read back; obsolete or superseded closes linked PRs. "
  + "Needs `LINEAR_API_KEY_<TEAM>` or `LINEAR_API_KEY`, `gh` and `omp`. Writes Linear, pushes, closes PRs, spends model quota; runs minutes to hours, not resumable; a failed run comments the failure on the ticket. "
  + "Returns `outcome` (undecipherable | already_done | obsolete | superseded | needs_info | work_completed | blocked), `linearStatus`, `work`, `improvement`, `closedPullRequests`.";

/** The run's answer as the text the model reads. */
export function stateText(state: State): string {
  const lines = [`${state.ticket}: ${state.outcome ?? "unsettled"} (Linear status: ${state.linearStatus ?? "unchanged"})`];
  if (state.closing !== undefined) lines.push(state.closing.summary);
  if (state.work !== undefined) lines.push(`Work: ${state.work.outcome} — ${state.work.summary}`);
  if (state.improvement !== undefined) lines.push(`Tooling: ${state.improvement.improvement} — ${state.improvement.summary}`);
  if (state.toolingError !== undefined) lines.push(`Tooling: unknown — ${state.toolingError}`);
  if (state.closedPullRequests.length > 0) lines.push(`Closed pull requests: ${state.closedPullRequests.join(", ")}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "relay",
    label: "Relay",
    description: DESCRIPTION,
    parameters: z.object({
      ticket: z.string().regex(TICKET_PATTERN).describe("Linear ticket identifier, exactly `ZYS-123` or `SAH-123`: the prefix names the workspace."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const exec: Exec = (command, args, options) => pi.exec(command, args, options);
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `relay ${params.ticket}: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, HEARTBEAT_MS);
      const live = liveRelayPorts({ exec, signal });
      try {
        const state = await runRelay(live.ports, {
          ticket: params.ticket,
          runId: crypto.randomUUID(),
          verdictDirectory: live.verdictDirectory,
          beforeWork: () => {
            toolingCheckout();
          },
          onStep: (step) => {
            phase = step;
          },
        });
        return {
          content: [{ type: "text", text: stateText(state) }],
          details: { ...state, seconds: Math.round((Date.now() - began) / 1000) },
        };
      } catch (error) {
        throw new Error(`relay ${params.ticket} failed in ${phase}: ${messageOf(error)}`, { cause: error });
      } finally {
        clearInterval(beat);
        await live.dispose();
      }
    },
  };
};

export default factory;
