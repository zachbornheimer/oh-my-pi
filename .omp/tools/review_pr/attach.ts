import { commentableLines } from "./diff.js";
import {
  changedFiles,
  type Gh,
  openThreads,
  postedOnPullRequest,
  postReview,
  resolveThread,
  summaryReview,
  updateReviewBody,
} from "./github.js";
import { planReview, threadsToResolve } from "./plan.js";
import type { AttachedReview, PullRequest, ReviewerResult } from "./types.js";

/**
 * Attaches every reviewer's findings to the PR as one review on the reviewed head. A later run replaces that review's
 * body, so a failure line does not stay after a clean run, and resolves threads from an older commit that this run
 * did not report again.
 */
export async function attachReview(
  gh: Gh,
  pr: PullRequest,
  reviewers: readonly ReviewerResult[],
): Promise<AttachedReview> {
  const [files, posted, existing, threads] = await Promise.all([
    changedFiles(gh, pr),
    postedOnPullRequest(gh, pr),
    summaryReview(gh, pr),
    openThreads(gh, pr),
  ]);
  // Planning throws when every reviewer failed, before anything is written to the PR.
  const plan = planReview(
    { owner: pr.owner, repo: pr.repo, headSha: pr.headSha },
    reviewers,
    commentableLines(files),
    posted,
  );
  const counts = { inline: plan.inline, in_summary: plan.in_summary, already_posted: plan.already_posted };
  let updated = false;
  if (existing !== undefined && existing.body !== plan.body) {
    await updateReviewBody(gh, existing.node_id, plan.body);
    updated = true;
  }
  const stale = threadsToResolve(threads, reviewers, pr.headSha);
  for (const threadId of stale) await resolveThread(gh, threadId);
  if (plan.comments.length === 0 && (existing !== undefined || !plan.post)) {
    return {
      posted: false,
      ...(existing === undefined ? {} : { id: existing.id, html_url: existing.html_url }),
      ...counts,
      updated,
      resolved: stale.length,
    };
  }
  const review = existing === undefined
    ? await postReview(gh, pr, plan)
    : await postReview(gh, pr, { ...plan, body: `New findings on \`${pr.headSha.slice(0, 7)}\`.` });
  return { posted: true, id: review.id, html_url: review.html_url, ...counts, updated, resolved: stale.length };
}
