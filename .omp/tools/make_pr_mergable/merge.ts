import { SETTLE_BUDGET_MS, SETTLE_POLL_MS } from "./constants.js";
import type { GitHubPorts } from "./ports.js";
import { readFacts } from "./read_facts.js";
import type { Facts, Target, Verdict } from "./types.js";

export type MergeResult = {
  merged: boolean;
  /** GitHub refused a merge that every precondition allowed (the head moved after the judgment). */
  refused: boolean;
  reason: string;
};

/**
 * The only merge. It runs when the caller asked to merge, the verdict is settled for the `approved` target (the default)
 * and the head the facts describe, and the gh user can push; otherwise it does nothing and says why. The merge names the
 * SHA that was judged (`--match-head-commit`), so a push after the judgment cannot merge unjudged code. A 0 from
 * `gh pr merge` is not a merge: a merge queue returns it for an enqueue too, so what landed is what `awaitMerged` observes.
 */
export async function mergeSettledApprovedPr(
  ports: Pick<GitHubPorts, "gh">,
  input: { facts: Facts; verdict: Verdict; merge: boolean; target?: Target },
): Promise<MergeResult> {
  const { facts, verdict } = input;
  if (!input.merge) return { merged: false, refused: false, reason: "" };
  if (facts.state !== "OPEN") {
    return { merged: false, refused: false, reason: `not merged: the pull request is ${facts.state.toLowerCase()}` };
  }
  if ((input.target ?? "approved") !== "approved") {
    return {
      merged: false,
      refused: false,
      reason: "not merged: only a pull request settled for the approved target is merged",
    };
  }
  if (verdict.kind !== "settled") {
    return { merged: false, refused: false, reason: `not merged: the verdict is ${verdict.kind}` };
  }
  if (verdict.headSha !== facts.headSha) {
    return { merged: false, refused: false, reason: "not merged: the verdict is for a different head than the facts" };
  }
  if (!facts.viewerCanPush) {
    return { merged: false, refused: false, reason: `not merged: ${facts.viewer} has no push access to ${facts.repo}` };
  }
  try {
    await ports.gh([
      "pr",
      "merge",
      String(facts.number),
      "--repo",
      facts.repo,
      "--squash",
      "--match-head-commit",
      verdict.headSha,
    ]);
  } catch (error) {
    const why = (error as Error).message.split("\n")[0];
    return { merged: false, refused: true, reason: `not merged: gh pr merge refused ${verdict.headSha}: ${why}` };
  }
  return { merged: true, refused: false, reason: "" };
}

/** What the merge step's squash merge landed: `merged`, `queued` (a merge queue holds the pull request OPEN) or `stuck` (closed without merging). */
export const landingStates = ["merged", "queued", "stuck"] as const;

/**
 * `gh pr merge` exits 0 for an enqueue into a merge queue as well as for a merge, so the merge step's success proves
 * nothing about what landed: this observes the pull request itself. It polls no faster than every SETTLE_POLL_MS, and
 * after SETTLE_BUDGET_MS it stops waiting and reports the pull request still OPEN as `queued` (the queue, not this run,
 * merges it) instead of blocking the run on a queue it cannot see into.
 */
export async function awaitMergedSettledApprovedPr(
  ports: GitHubPorts,
  input: { prUrl: string },
): Promise<{ state: (typeof landingStates)[number]; reason: string }> {
  const { prUrl } = input;
  const deadline = ports.now().getTime() + SETTLE_BUDGET_MS;
  let facts = await readFacts(ports, prUrl);
  while (facts.state === "OPEN") {
    if (ports.now().getTime() + SETTLE_POLL_MS > deadline) {
      return {
        state: "queued",
        reason: `merge queue has not merged ${facts.headSha} within ${SETTLE_BUDGET_MS / 60_000} minutes; the queue, not this run, merges it`,
      };
    }
    await ports.sleep(SETTLE_POLL_MS);
    facts = await readFacts(ports, prUrl);
  }
  if (facts.state === "MERGED") return { state: "merged", reason: "" };
  return {
    state: "stuck",
    reason: `gh pr merge was accepted and the pull request is ${facts.state.toLowerCase()}, not merged (mergeStateStatus ${facts.mergeStateStatus})`,
  };
}
