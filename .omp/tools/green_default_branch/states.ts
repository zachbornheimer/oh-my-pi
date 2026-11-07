import { AGENT_LIMIT_MS, DAILY_AGENT_CAP_MS } from "./constants.js";

export const REPO_STATES = [
  "queued",
  "green",
  "no-ci",
  "flaky-rerun",
  "rerun-failed",
  "infra",
  "api-error",
  "unclassified",
  "deferred",
  "fixing",
  "awaiting-merge",
  "unfixed",
  "timed-out",
  "needs-human",
] as const;

export type RepoState = (typeof REPO_STATES)[number];

export type FailingJob = { name: string; conclusion: string; logUrl: string };

export type Basis =
  | { kind: "fresh-rollup-success"; rollup: string }
  | { kind: "squash-merge-success"; headSha: string; mergeCommit: string; rollup: string }
  | { kind: "no-workflows"; status: number; workflowCount: number }
  | { kind: "observed"; evidence: string };

export function isRepoState(value: string): value is RepoState {
  return (REPO_STATES as readonly string[]).includes(value);
}

/** Green from a squash merge only when HEAD is that commit and the fresh rollup succeeded. */
export function greenFromMerge(headSha: string, mergeCommit: string, rollup: string): boolean {
  return mergeCommit !== "" && headSha === mergeCommit && rollup === "SUCCESS";
}

export function transitionAllowed(to: RepoState, basis: Basis): boolean {
  if (to === "green" && basis.kind === "fresh-rollup-success") return basis.rollup === "SUCCESS";
  if (to === "green" && basis.kind === "squash-merge-success") {
    return greenFromMerge(basis.headSha, basis.mergeCommit, basis.rollup);
  }
  if (to === "green") return false;
  if (to === "no-ci") return basis.kind === "no-workflows" && basis.status === 200 && basis.workflowCount === 0;
  return true;
}

/** The local calendar day, `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The day's agent time leaves no room for one more full agent run. */
export function agentCapReached(elapsedTodayMs: number): boolean {
  return DAILY_AGENT_CAP_MS - elapsedTodayMs < AGENT_LIMIT_MS;
}

/** One ledger write a step wants made. The ledger adds the time, the run and the repository. */
export type OutcomeStep = {
  from: string;
  to: RepoState;
  evidence: string;
  /** Proof the transition needs; a step that carries one is refused when `transitionAllowed` says no. */
  basis?: Basis;
  defaultBranch?: string;
  failingJobs?: FailingJob[];
  prUrl?: string;
  pid?: number | null;
  elapsedSeconds?: number;
};

/**
 * What one repository's run decided: the ledger writes in order, and why the last one needs a person (returned to the
 * caller, never announced).
 */
export type Outcome = { steps: OutcomeStep[]; human?: string };

export const GREEN_BASIS: Basis = { kind: "fresh-rollup-success", rollup: "SUCCESS" };
export const NO_CI_BASIS: Basis = { kind: "no-workflows", status: 200, workflowCount: 0 };
