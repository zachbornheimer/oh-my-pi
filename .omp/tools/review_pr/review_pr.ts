import { attachReview } from "./attach.js";
import { type Runner } from "./exec.js";
import { getPullRequest, ghOver } from "./github.js";
import { REVIEWERS, type Reviewer, runReviewer } from "./reviewers.js";
import type { ReviewPrOutput } from "./types.js";

export interface ReviewPrDeps {
  /** Runs every external program (`gh`, `git`, `ocr`, `semgrep`). */
  run: Runner;
  signal?: AbortSignal;
  /** Called with a short phase name as the run advances. */
  progress?: (phase: string) => void;
  /** Defaults to OpenCodeReview and Semgrep. */
  reviewers?: readonly Reviewer[];
}

/**
 * Reviews one open PR with every reviewer in parallel, then attaches the findings to it as one review. The three steps
 * run in order: pin the PR's base and head, run the reviewers (each returns complete or failed, never throws), attach.
 */
export async function reviewPr(url: string, deps: ReviewPrDeps): Promise<ReviewPrOutput> {
  const gh = ghOver(deps.run, deps.signal);
  const reviewers = deps.reviewers ?? REVIEWERS;
  deps.progress?.("reading the pull request");
  const pr = await getPullRequest(gh, url);
  deps.progress?.(`running ${reviewers.map((reviewer) => reviewer.name).join(" and ")}`);
  const results = await Promise.all(
    reviewers.map((reviewer) => runReviewer(reviewer, pr, { run: deps.run, signal: deps.signal })),
  );
  deps.progress?.("attaching the review to the pull request");
  const review = await attachReview(gh, pr, results);
  return { url: pr.url, head_sha: pr.headSha, reviewers: results, review };
}

/** The model-facing summary of one run. The full record is the tool's `details`. */
export function outcomeText(output: ReviewPrOutput): string {
  const { review } = output;
  const reviewers = output.reviewers
    .map((result) => `${result.reviewer}: ${result.status}${result.error ? ` (${result.error.split("\n")[0]})` : ""}, ${result.findings.length} finding(s)`)
    .join("; ");
  const where = review.posted ? `posted review ${review.html_url ?? review.id}` : "posted nothing new";
  return [
    `review_pr ${output.url} at ${output.head_sha.slice(0, 7)}: ${where}.`,
    `${review.inline} inline, ${review.in_summary} in summary, ${review.already_posted} already on the PR; summary replaced: ${review.updated}; threads resolved: ${review.resolved}.`,
    reviewers,
  ].join("\n");
}
