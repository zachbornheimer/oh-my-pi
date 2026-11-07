import { contextOf, type RepositoryContext } from "./context.js";
import type { Host } from "./host.js";
import { appendEvent, derive, type LedgerEvent, readEvents, readRow } from "./ledger.js";
import { type Outcome, type OutcomeStep, transitionAllowed } from "./states.js";

export type Recorded = {
  /** The repository's state after this outcome. */
  state: string;
  /** The ledger's last event for the repository. */
  evidence: string;
  prUrl: string;
  /** Why a person is needed. Set when the outcome ends needs-human. */
  needsHuman?: string;
  attemptsToday: number;
};

type Draft = Pick<LedgerEvent, "from" | "to" | "evidence"> & Partial<LedgerEvent>;

/**
 * Appends one repository's outcome to the ledger, in order. A step that carries proof is refused, and recorded as
 * `unclassified`, when the proof does not allow its state. A needs-human reason is returned to the caller, never
 * announced.
 */
export async function appendRepositoryOutcomeToLedger(
  host: Host,
  input: RepositoryContext,
  outcome: Outcome,
): Promise<{ context: RepositoryContext; recorded: Recorded }> {
  const context = contextOf(input);
  const repo = input.nameWithOwner;
  const runId = input.runId ?? (derive(await readEvents(host), host.now().toISOString()).runId
    || `rg-${host.now().toISOString()}`);
  const write = (step: Draft) =>
    appendEvent(host, { ...step, at: host.now().toISOString(), runId, nameWithOwner: repo });
  let human = outcome.human;
  for (const step of outcome.steps) {
    if (step.basis !== undefined && !transitionAllowed(step.to, step.basis)) {
      await write({ from: step.from, to: "unclassified", evidence: `refused ${step.to}: ${step.evidence}` });
      if (step.to === "needs-human") human = undefined;
      continue;
    }
    await write(eventOf(step));
  }
  const row = await readRow(host, repo);
  if (row === undefined) throw new Error(`no ledger row for ${repo} after recording its outcome`);
  return {
    context,
    recorded: {
      state: row.state,
      evidence: row.lastEvent,
      prUrl: row.prUrl,
      needsHuman: human,
      attemptsToday: row.attemptsToday,
    },
  };
}

function eventOf(step: OutcomeStep): Draft {
  return {
    from: step.from,
    to: step.to,
    evidence: step.evidence,
    defaultBranch: step.defaultBranch,
    failingJobs: step.failingJobs,
    prUrl: step.prUrl,
    pid: step.pid,
    elapsedSeconds: step.elapsedSeconds,
  };
}
