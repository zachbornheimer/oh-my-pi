import { changeRequest, requestCodeChanges } from "./agent.js";
import { PR_BUDGET, until } from "./budget.js";
import { type CheckRollupEntry, type CiResult, ciVerdict, settledCiVerdict } from "./ci_verdict.js";
import { getPullRequest, type PullRequest, readCi, unresolvedReviewThreads } from "./github.js";
import { type Finding, reviewPullRequest, type ReviewResult } from "./ocr.js";
import type { ImprovePorts } from "./ports.js";

export const CI_POLL_MS = 30_000;

export type CiStatus = "green" | "red" | "no-checks" | "timed-out" | "stale";
export type ReviewStatus = "complete" | "skipped";

/** What a run reports. `requiresAnotherPass` is true unless CI is green, no thread is open, and the head did not move. */
export interface Outcome {
  improvedPrUrl: string;
  ciStatus: CiStatus;
  reviewedHeadSha: string;
  finalHeadSha: string;
  requiresAnotherPass: boolean;
  reviewStatus: ReviewStatus;
  unresolvedThreads: number;
}

/** Step 3: hand every reviewer finding to one agent run, unless the head moved since the review. */
async function fixReviewFindings(
  ports: ImprovePorts,
  pr: PullRequest,
  reviews: readonly ReviewResult[],
): Promise<ReviewStatus> {
  if (reviews.some((review) => review.headSha !== pr.headSha)) {
    throw new Error("Review findings are for a different commit");
  }
  // A reviewer is permitted to report no findings. Do not spend agent calls on that.
  const findings = reviews.flatMap((review) =>
    review.findings.map((item: Finding) => ({ reviewer: review.reviewer, ...item }))
  );
  if (findings.length > 0) {
    const current = await readCi(ports.run, pr.url);
    if (current.headSha !== pr.headSha) {
      throw new Error("PR head changed after review; restart from a new snapshot");
    }
    ports.progress(`fixing ${findings.length} review finding${findings.length === 1 ? "" : "s"} (omp)`);
    await requestCodeChanges(
      ports,
      pr.url,
      changeRequest(
        pr.url,
        "Verify and resolve each substantive finding. Respond to false positives with evidence, not a cosmetic rewrite.",
        findings,
      ),
    );
  }
  return reviews.some((review) => review.status === "skipped") ? "skipped" : "complete";
}

/** Step 4: one agent run per unresolved review thread, in order: a fix for one thread may resolve later threads. */
async function addressReviewThreads(ports: ImprovePorts, pr: PullRequest): Promise<void> {
  const threads = await unresolvedReviewThreads(ports.run, pr);
  for (const thread of threads) {
    if (!(await unresolvedReviewThreads(ports.run, pr)).some((current) => current.id === thread.id)) continue;
    ports.progress(`addressing review thread ${thread.id} (omp)`);
    await requestCodeChanges(
      ports,
      pr.url,
      changeRequest(
        pr.url,
        `Investigate review thread ${thread.id}. Fix the issue, or explain with evidence why it does not apply. `
          + "Reply to the thread and resolve it only when justified.",
        { threadId: thread.id, initial: thread.initial.nodes, latest: thread.latest.nodes },
      ),
    );
    // Verification is performed after CI; do not claim comments were resolved here.
  }
}

/** A CI reading, and whether green survived a second read of the head: a certified green is never a stale one. */
type CiObservation = CiResult & { readonly stable: boolean };

/** Step 5: wait for CI on the current head; on red, one agent round per failure set, on Flight's budget. */
async function makeCiGreen(ports: ImprovePorts, pr: PullRequest, reviewStatus: ReviewStatus): Promise<Outcome> {
  const loop = await until<CiObservation, CheckRollupEntry>({
    name: "improve_pr_ci",
    owner: pr.url,
    observe: async () => {
      ports.progress("waiting for CI on the current head");
      const settled = await settledCiVerdict(() => readCi(ports.run, pr.url), () => ports.sleep(CI_POLL_MS));
      if (settled.verdict !== "green") return { ...settled, stable: true };
      const current = await readCi(ports.run, pr.url);
      return { ...settled, stable: current.headSha === settled.headSha && ciVerdict(current.rollup) === "green" };
    },
    key: (reading) => reading.headSha,
    judge: (reading) => {
      if (reading.verdict === "green") {
        return reading.stable
          ? { done: true }
          : { waiting: "the head or its checks changed while green was certified" };
      }
      if (reading.verdict === "red") {
        return { issues: reading.rollup.filter((check) => ciVerdict([check]) === "red") };
      }
      return { impossible: `CI is ${reading.verdict}` };
    },
    work: (reading, failures) => {
      ports.progress(`fixing failed CI checks on ${reading.headSha.slice(0, 10)} (omp)`);
      return requestCodeChanges(
        ports,
        pr.url,
        changeRequest(
          pr.url,
          "Fix the observed CI failures on the current PR head, then commit and push. "
            + "Do not modify checks merely to mask a failure. If an external service failed, investigate and rerun it when appropriate.",
          { headSha: reading.headSha, failedChecks: failures },
        ),
      );
    },
    budget: PR_BUDGET,
  }, { ledger: ports.ledger, now: ports.now, sleep: ports.sleep, pollMs: CI_POLL_MS });

  // `impossible` is CI with nothing to fix (no checks, or never finished); `spent` is red, or green that never held still.
  let ciStatus: CiStatus = loop.status === "done"
    ? "green"
    : loop.status === "impossible"
    ? (loop.reading.verdict as CiStatus)
    : loop.reading.verdict === "green"
    ? "stale"
    : "red";
  const finalCi = await readCi(ports.run, pr.url);
  if (ciStatus === "green" && ciVerdict(finalCi.rollup) !== "green") ciStatus = "stale";
  const unresolvedThreads = (await unresolvedReviewThreads(ports.run, pr)).length;
  return {
    improvedPrUrl: pr.url,
    ciStatus,
    reviewStatus,
    reviewedHeadSha: pr.headSha,
    finalHeadSha: finalCi.headSha,
    requiresAnotherPass: ciStatus !== "green" || unresolvedThreads > 0 || finalCi.headSha !== pr.headSha,
    unresolvedThreads,
  };
}

/** Review a GitHub PR, apply justified fixes, address unresolved review threads, and report verified CI status. */
export async function improvePr(ports: ImprovePorts, prUrl: string): Promise<Outcome> {
  ports.progress("reading the pull request");
  const pr = await getPullRequest(ports.run, prUrl);
  ports.progress("reviewing the pinned head with OpenCodeReview");
  const review = await reviewPullRequest(ports, pr);
  const reviewStatus = await fixReviewFindings(ports, pr, [review]);
  await addressReviewThreads(ports, pr);
  return makeCiGreen(ports, pr, reviewStatus);
}

/** What the model reads: the verdict first, then the facts a caller acts on. */
export function outcomeText(outcome: Outcome): string {
  return [
    `${outcome.improvedPrUrl}: CI ${outcome.ciStatus}, review ${outcome.reviewStatus}, ${outcome.unresolvedThreads} unresolved thread${
      outcome.unresolvedThreads === 1 ? "" : "s"
    }, ${outcome.requiresAnotherPass ? "another pass required" : "no further pass required"}`,
    `  reviewed head ${outcome.reviewedHeadSha}`,
    `  final head    ${outcome.finalHeadSha}`,
  ].join("\n");
}
