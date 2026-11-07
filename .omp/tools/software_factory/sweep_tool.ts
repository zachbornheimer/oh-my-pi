import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { CHECKPOINT_DIR, HEARTBEAT_MS, SWEEP_DEFAULT_LIMIT } from "./constants.js";
import type { FactoryPorts } from "./ports.js";
import { runSweep, type SweepResult } from "./sweep.js";
import { knownTeams } from "./workspaces.js";

const DESCRIPTION =
  `Sweep the Linear backlog of the workspaces the factory knows (${knownTeams()}) and work the next tickets, one at a time on this machine. `
  + `It lists each workspace's input statuses (Triage/Unreviewed/Ready for Dev for SAH; Unreviewed/Ready for Development for ZYS), orders the tickets by priority (Urgent first, no priority last) then age, takes \`limit\` (default ${SWEEP_DEFAULT_LIMIT}), and runs the full \`software_factory_ticket\` flow on each in turn: /tickets analysis, repository, worktree, adversarial root-cause review, omp implementation, adversarial diff review, PR, fix_red_ci, Linear status and comment, landing when \`merge\`. `
  + "Input `{\"teams\":[\"ZYS\"],\"project\":\"AI Tooling\",\"limit\":3,\"merge\":false}`: `teams` limits it to those workspaces (default all), `project` to one Linear project (a workspace without that project contributes nothing), `merge` lets settled pull requests be landed. "
  + `A held machine-wide lock makes a ticket \`busy\`, touching nothing. Each ticket checkpoints every finished step in ${CHECKPOINT_DIR}/<TICKET>.json, so running the sweep again takes up an interrupted ticket first (counting toward \`limit\`; not when \`project\` is given) and skips its finished steps; cancelling keeps the files. A ticket whose run fails stops the sweep there and is named in \`stopped\`. `
  + "Needs a Linear key per workspace (`LINEAR_API_KEY_<TEAM>`, `LINEAR_API_KEY`, or the Keychain), `gh`, `git` and `omp`. "
  + "Mutates Linear, GitHub (pushes, PRs, merges) and the checkouts, and spends model quota for hours; sends progress updates. "
  + "Returns `tickets` (each with `outcome`, `linearStatus`, `landing`, `prLanded`, `resumed`) and `stopped` when a ticket failed.";

export function sweepText(result: SweepResult): string {
  const lines = result.tickets.map(
    (ticket) =>
      `${ticket.ticket}: ${ticket.outcome ?? "no outcome"}${ticket.linearStatus === undefined ? "" : `, Linear status ${ticket.linearStatus}`}${ticket.resumed === true ? " (resumed)" : ""}`,
  );
  return [
    result.tickets.length === 0 && result.stopped === undefined ? "No eligible ticket." : `Worked ${result.tickets.length} ticket(s).`,
    ...lines,
    ...(result.stopped === undefined ? [] : [`Stopped at ${result.stopped.ticket}: ${result.stopped.error}`]),
  ].join("\n");
}

/** The tool over the ports `makePorts` builds for one call; `index.ts` passes the real ones, a test its own and a short heartbeat. */
export function sweepTool(
  makePorts: (signal: AbortSignal | undefined) => FactoryPorts,
  heartbeatMs: number = HEARTBEAT_MS,
): CustomToolFactory {
  return (pi) => ({
    name: "software_factory",
    label: "Software factory",
    description: DESCRIPTION,
    parameters: pi.zod.object({
      teams: pi.zod.array(pi.zod.string()).nullable().optional().describe(`Workspace team keys to sweep (${knownTeams()}). Default: all of them.`),
      project: pi.zod.string().nullable().optional().describe("Only tickets of this Linear project (name or id). Default: every project."),
      limit: pi.zod.number().int().min(1).nullable().optional().describe(`How many tickets to work, one after another. Default ${SWEEP_DEFAULT_LIMIT}.`),
      merge: pi.zod.boolean().nullable().optional().describe("Land each pull request once settled approved. Default false: they are only driven to settled."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `software_factory: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, heartbeatMs);
      try {
        const result = await runSweep(
          makePorts(signal),
          {
            ...(params.teams == null ? {} : { teams: params.teams }),
            ...(params.project == null ? {} : { project: params.project }),
            ...(params.limit == null ? {} : { limit: params.limit }),
            merge: params.merge ?? false,
          },
          {
            ...(signal === undefined ? {} : { signal }),
            progress: (message) => {
              phase = message;
            },
          },
        );
        return {
          content: [{ type: "text", text: sweepText(result) }],
          details: { ...result, seconds: Math.round((Date.now() - began) / 1000) },
        };
      } finally {
        clearInterval(beat);
      }
    },
  });
}
