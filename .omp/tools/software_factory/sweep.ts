import { CHECKPOINT_MAX_AGE_MS, SWEEP_DEFAULT_LIMIT } from "./constants.js";
import { workspaceFor } from "./workspaces.js";
import type { FactoryPorts } from "./ports.js";
import type { Landing, Outcome } from "./schemas.js";
import { listEligibleTickets } from "./steps_intake.js";
import { messageOf } from "./run_ledger.js";
import { type Progress, runTicket } from "./workflow.js";

export const SOFTWARE_FACTORY_ID = "software_factory";

export type SweepTicket = {
  ticket: string;
  outcome?: Outcome;
  linearStatus?: string;
  landing?: Landing;
  prLanded?: boolean;
  /** True when the ticket's run began from an earlier run's checkpoint. */
  resumed?: true;
};

export type SweepResult = {
  tickets: SweepTicket[];
  /** Set when a ticket's run failed: the sweep stops there, and the tickets after it were not started. */
  stopped?: { ticket: string; error: string };
};

/**
 * Works the next tickets of every workspace the factory knows (or only the teams and project given), one at a time:
 * lists them by priority then age, takes `limit`, and runs the ticket workflow on each in turn. Its machine-wide lock keeps
 * even two sweeps from overlapping. A ticket whose run fails stops the sweep; the outcomes before it are kept.
 */
export async function runSweep(
  ports: FactoryPorts,
  input: { teams?: readonly string[]; project?: string; limit?: number; merge: boolean },
  options: { signal?: AbortSignal; progress?: Progress } = {},
): Promise<SweepResult> {
  const limit = input.limit ?? SWEEP_DEFAULT_LIMIT;
  // A ticket an earlier run left unfinished is no longer in an input status (the run moved it to In Progress), so the
  // listing cannot find it: its checkpoint can. Those come first, oldest first, and count toward the limit. A project
  // filter cannot be checked against a checkpoint, so a sweep of one project resumes none.
  const resumable = input.project !== undefined
    ? []
    : (await ports.checkpoints.list())
      .filter(
        (checkpoint) =>
          !checkpoint.finished
          && ports.now() - checkpoint.updatedAt <= CHECKPOINT_MAX_AGE_MS
          && (input.teams === undefined || input.teams.some((team) => team.toLowerCase() === workspaceFor(checkpoint.ticket).team.toLowerCase())),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((checkpoint) => checkpoint.ticket);
  const listed = resumable.length >= limit
    ? []
    : await listEligibleTickets(ports, {
      ...(input.teams === undefined ? {} : { teams: input.teams }),
      ...(input.project === undefined ? {} : { project: input.project }),
      limit,
    });
  const tickets = [...new Set([...resumable, ...listed])].slice(0, limit);
  options.progress?.(`${tickets.length} ticket(s) to work: ${tickets.join(", ") || "none"}`);
  const done: SweepTicket[] = [];
  for (const ticket of tickets) {
    options.signal?.throwIfAborted();
    try {
      const { state, resumed } = await runTicket(ports, { ticket, merge: input.merge }, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.progress === undefined ? {} : { progress: options.progress }),
      });
      done.push({
        ticket,
        ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
        ...(state.linearStatus === undefined ? {} : { linearStatus: state.linearStatus }),
        ...(state.landing === undefined ? {} : { landing: state.landing }),
        ...(state.prLanded === undefined ? {} : { prLanded: state.prLanded }),
        ...(resumed ? { resumed: true as const } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      return { tickets: done, stopped: { ticket, error: messageOf(error) } };
    }
  }
  return { tickets: done };
}
