import type { Host } from "./host.js";
import type { UpgradeRunner } from "./upgrade_runner.js";

/** Drives one pull request to merged, the way `make_pr_mergable` with merging on does. */
export type DrivePr = (prUrl: string) => Promise<{ exitCode: number; text: string }>;

/** What every step of a run is handed: the effects, a progress sink, and the two collaborators that are not `gh` or `git`. */
export type Ctx = {
  host: Host;
  /** Tells whoever is watching what the run is doing now (the tool's heartbeat). */
  progress: (message: string) => void;
  /** Runs `upgrade_dependency` on one pull request. */
  upgrade: UpgradeRunner;
  /** Takes one pull request to merged when it is not settled approved. */
  drive: DrivePr;
};

/** What every per-repository step takes. Everything but the name has a default or is read when absent. */
export type RepositoryContext = {
  nameWithOwner: string;
  /** Read from GitHub when absent. */
  defaultBranch?: string;
  /** The ledger's current run when absent. */
  runId?: string;
  /** True records and never reruns, fixes, merges or upgrades. */
  dryRun?: boolean;
  /** True when the run continues an unfinished one. */
  resumed?: boolean;
};

/** The fields every step hands on to the next. */
export function contextOf(input: RepositoryContext): RepositoryContext {
  return {
    nameWithOwner: input.nameWithOwner,
    defaultBranch: input.defaultBranch,
    runId: input.runId,
    dryRun: input.dryRun,
    resumed: input.resumed,
  };
}
