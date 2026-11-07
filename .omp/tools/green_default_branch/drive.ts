import type { DrivePr } from "./context.js";
import { livePorts } from "./pr/live_ports.js";
import { makePrMergable, stateText } from "./pr/workflow.js";

/**
 * Takes one pull request to merged: `make_pr_mergable`'s rounds with merging on (headless omp fixes, one push per
 * round, the squash merge only from settled approved). Exit 0 when the pull request is merged, queued into a merge
 * queue, or done; 1 when it is impossible, spent or still working. The run's progress goes to `progress`.
 */
export function makePrMergableDrive(options: { signal?: AbortSignal; progress: (message: string) => void }): DrivePr {
  return async (prUrl) => {
    const state = await makePrMergable(livePorts(options), { prUrl, merge: true, dryRun: false });
    const done = state.status === "merged" || state.status === "queued" || state.status === "done";
    return { exitCode: done ? 0 : 1, text: stateText(state) };
  };
}
