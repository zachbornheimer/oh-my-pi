import { CHECKS_REGISTRATION_WAIT_MS, REVIEWER_REREVIEW_WAIT_MS } from "./constants.js";
import type { Facts, Gate, Issue, Target, Verdict } from "./types.js";

/**
 * The exit criteria for a pull request, the one place they are written.
 *
 * - `mergeable`: the head's checks are complete and SUCCESS, the branch does not conflict (`mergeStateStatus` is not
 *   DIRTY), no unresolved inline thread, no comment without a fix pushed after it, and no caller gate failed (only a
 *   `failed` gate blocks: `passed` and `not_proven` do not).
 * - `approved`: `mergeable` plus no CHANGES_REQUESTED, `reviewDecision` not REVIEW_REQUIRED, every reviewer has a review
 *   on the head (or the bounded wait since the push passed), and `mergeStateStatus` CLEAN.
 */

/**
 * Why a reading is or is not settled, before it is reduced to one answer. `terminal` is set only for a pull request
 * that is already `MERGED` (nothing left to do) or `CLOSED` (unmerged and impossible); it then wins over everything,
 * and the other fields stay empty so no gate, round or merge follows from a terminal reading. `pending` reasons resolve on
 * their own within a bound; `blocking` ones do not. `issues` is the work a fix round can do about them. `impossible`
 * is set when nothing here can settle it: a closed pull request, a head with no push access that still has work, or a
 * draft with nothing left to fix. A draft's own open issues are worked first.
 */
export interface Assessment {
  readonly terminal?: "merged" | "closed";
  readonly impossible: string | undefined;
  readonly pending: readonly string[];
  readonly blocking: readonly string[];
  readonly issues: readonly Issue[];
}

/** `mergeStateStatus` while GitHub is still working it out. */
const MERGE_STATE_UNKNOWN = "UNKNOWN";
const MERGE_STATE_CLEAN = "CLEAN";
const MERGE_STATE_DIRTY = "DIRTY";
const MERGE_STATE_BEHIND = "BEHIND";

const MERGE_STATE_WHY: Readonly<Record<string, string>> = {
  [MERGE_STATE_DIRTY]: "the branch conflicts with its base",
  [MERGE_STATE_BEHIND]: "the branch is behind its base",
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Review bots wrap findings in badge HTML; the agent needs the words. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The work a fix round is given, one issue per commit: a base merge when the branch conflicts (or, for `approved`, is
 * behind), each unresolved thread, each failed check, each comment whose author can push, and each failed gate. A
 * comment from an author who cannot push still blocks but is never handed to the agent: a drive-by must not steer a
 * push to the branch.
 */
export function openIssues(facts: Facts, target: Target, gates: readonly Gate[]): Issue[] {
  const issues: Issue[] = [];
  const why = MERGE_STATE_WHY[facts.mergeStateStatus];
  const needsBase = facts.mergeStateStatus === MERGE_STATE_DIRTY
    || (target === "approved" && facts.mergeStateStatus === MERGE_STATE_BEHIND);
  if (why !== undefined && needsBase) issues.push({ kind: "merge-base", baseRef: facts.baseRef, why });
  for (const thread of facts.unresolvedThreads) {
    issues.push({
      kind: "thread",
      id: thread.id,
      path: thread.path,
      author: thread.author,
      body: plainText(thread.body),
    });
  }
  for (const name of facts.checks.failed) issues.push({ kind: "failed-check", name });
  for (const note of facts.openComments.filter((open) => open.trusted)) {
    issues.push({ kind: "comment", id: note.id, author: note.author, body: plainText(note.body) });
  }
  for (const gate of gates) {
    if (gate.verdict === "failed") issues.push({ kind: "gate", name: gate.name, observed: gate.observed });
  }
  return issues;
}

/** Whether the viewer can push commits to the pull request's head branch (base push access, or the fork's author). */
export function canPushHead(facts: Facts): boolean {
  if (facts.viewerCanPush) return true;
  if (!facts.isCrossRepository || facts.viewer === "") return false;
  const headOwner = facts.headRepo?.split("/")[0] ?? facts.author;
  return facts.author === facts.viewer || headOwner === facts.viewer;
}

/**
 * Pure: the same facts, target and gates give the same assessment, and the clock is the facts' `observedAt`. Anything
 * that resolves by itself within its bound is `pending`; any other shortfall is `blocking`. A pending reason wins over a
 * blocking one for the verdict, so a head is only blocked once nothing is left to wait for. A failed gate is blocking
 * and an issue; a `passed` or `not_proven` gate is neither.
 */
export function assess(facts: Facts, target: Target, gates: readonly Gate[]): Assessment {
  if (facts.state === "MERGED") {
    return { terminal: "merged", impossible: undefined, pending: [], blocking: [], issues: [] };
  }
  if (facts.state === "CLOSED") {
    return { terminal: "closed", impossible: "the pull request is closed", pending: [], blocking: [], issues: [] };
  }
  const pending: string[] = [];
  const blocking: string[] = [];
  const sincePush = Date.parse(facts.observedAt) - Date.parse(facts.headPushedAt);
  const approved = target === "approved";

  if (facts.checks.verdict === "pending") pending.push(`checks pending: ${facts.checks.pending.join(", ")}`);
  else if (facts.checks.verdict === "red") blocking.push(`checks red: ${facts.checks.failed.join(", ")}`);
  else if (facts.checks.verdict === "no-checks" && !facts.isCrossRepository) {
    (sincePush < CHECKS_REGISTRATION_WAIT_MS ? pending : blocking).push("no checks reported on the head");
  }

  if (facts.unresolvedThreads.length > 0) {
    blocking.push(plural(facts.unresolvedThreads.length, "unresolved review thread"));
  }
  if (facts.openComments.length > 0) {
    blocking.push(plural(facts.openComments.length, "comment") + " without a fix pushed after");
  }

  if (approved) {
    const stale = facts.reviewers.filter((reviewer) => reviewer.commitSha !== facts.headSha);
    if (stale.length > 0 && sincePush < REVIEWER_REREVIEW_WAIT_MS) {
      pending.push(`awaiting re-review of the head from ${stale.map((reviewer) => reviewer.login).join(", ")}`);
    }
    const changesRequested = facts.reviewers.filter((reviewer) => reviewer.state === "CHANGES_REQUESTED");
    if (changesRequested.length > 0) {
      blocking.push(`CHANGES_REQUESTED by ${changesRequested.map((reviewer) => reviewer.login).join(", ")}`);
    } else if (facts.reviewDecision === "CHANGES_REQUESTED") blocking.push("reviewDecision is CHANGES_REQUESTED");
    if (facts.reviewDecision === "REVIEW_REQUIRED") blocking.push("reviewDecision is REVIEW_REQUIRED");
  }

  if (facts.mergeStateStatus === MERGE_STATE_UNKNOWN) pending.push("GitHub has not computed mergeStateStatus");
  else if (approved ? facts.mergeStateStatus !== MERGE_STATE_CLEAN : facts.mergeStateStatus === MERGE_STATE_DIRTY) {
    blocking.push(`mergeStateStatus is ${facts.mergeStateStatus}`);
  }

  for (const gate of gates) {
    if (gate.verdict === "failed") blocking.push(`gate ${gate.name} failed: ${gate.observed}`);
  }

  const issues = openIssues(facts, target, gates);
  // A draft blocks merging, not fixing: its issues are worked, and only once none is left is the draft itself the
  // reason to stop. No push access ends the work only when there is work to do: a pull request with nothing to fix is
  // not blocked by it.
  const impossible = !canPushHead(facts) && issues.length > 0
    ? `${facts.viewer} has no push access to ${facts.repo}, so nothing can be fixed`
    : facts.isDraft && issues.length === 0
    ? "the pull request is a draft"
    : undefined;

  return { impossible, pending, blocking, issues };
}

/**
 * Rule 5 for `target`: anything that will resolve by itself within its bound makes the verdict `working`; any other
 * shortfall is `blocked`. Terminal `merged` and `closed` take precedence over checks and reviews. For an open head, a
 * pending reason wins over a blocking one, so a verdict is only `blocked` once nothing is left to wait for.
 */
export function judgePrSettled(facts: Facts, target: Target, gates: readonly Gate[]): Verdict {
  const { terminal, impossible, pending, blocking } = assess(facts, target, gates);
  if (terminal !== undefined) {
    return { kind: terminal, headSha: facts.headSha, reasons: impossible === undefined ? [] : [impossible] };
  }
  const blockers = impossible === undefined ? blocking : [impossible, ...blocking];
  const reasons = [...pending, ...blockers];
  const kind = pending.length > 0 ? "working" : blockers.length > 0 ? "blocked" : "settled";
  return { kind, headSha: facts.headSha, reasons };
}
