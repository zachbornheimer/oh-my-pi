import type { SpendLedger } from "./budget.js";
import type { ModelStep } from "./omp_model.js";

/** Every effect a fix_red_ci step has. Tests substitute these; `live_ports.ts` is the real one. */
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
  /** One bare model completion (no tools): the prompt in, the reply text out. */
  model: ModelStep;
  /** Lifetime USD per pull request, keyed by its URL (`PR_BUDGET.costUsd`): every round is charged here. */
  ledger: SpendLedger;
  now(): Date;
  /** Waits `ms`; rejects when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Tells whoever is watching what the run is doing now (the tool's heartbeat), so a long wait reads as a wait. */
  progress(message: string): void;
}

/** What reading and judging need. */
export type GitHubPorts = Pick<PrPorts, "gh" | "now" | "sleep">;
