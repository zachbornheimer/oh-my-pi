import type { SpendLedger } from "./budget.js";

/** Every effect a make_pr_mergable step has. Tests substitute these; `live_ports.ts` is the real one. */
export interface PrPorts {
  /** Runs `gh`, returns stdout, throws with stderr on a non-zero exit. */
  gh(args: readonly string[]): Promise<string>;
  /** Runs `git` in `cwd`, returns stdout, throws with stderr on a non-zero exit. */
  git(args: readonly string[], cwd: string): Promise<string>;
  /**
   * A private checkout of the pull request's head, detached at that commit and clean: reusing the directory of an earlier
   * round is normal, and whatever that round left in it (a stopped merge, staged or untracked files) is discarded.
   */
  checkout(prUrl: string): Promise<string>;
  /**
   * Runs an omp role headless in `cwd` and returns its exit status, or `ROUND_BUDGET_EXIT` (124) when the live port
   * stopped it at `ROUND_AGENT_BUDGET_MS`: a round is bounded, never waited on past its budget.
   */
  runAgent(input: { cwd: string; prompt: string; role: string }): Promise<number>;
  /** Lifetime USD per pull request, keyed by its URL (`PR_BUDGET.costUsd`): every round is charged here. */
  ledger: SpendLedger;
  now(): Date;
  /** Waits `ms`; rejects when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Tells whoever is watching what the run is doing now (the tool's heartbeat), so a long wait reads as a wait. */
  progress(message: string): void;
}

/** What reading, judging and merging need. */
export type GitHubPorts = Pick<PrPorts, "gh" | "now" | "sleep">;
