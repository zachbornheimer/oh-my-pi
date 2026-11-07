import { arr, bool, dflt, type Infer, int, obj, oneOf, opt, refine, type Shape, str } from "./shape.js";
import { knownTeams } from "./workspaces.js";

/** A Linear ticket identifier: a team key, a dash, a number. Which workspaces the factory works is `workspaces.ts`'s. */
export const TICKET_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export const ticketShape = str({
  pattern: TICKET_PATTERN,
  message: `a Linear ticket identifier such as SAH-123 (the factory works ${knownTeams()})`,
});

export const OUTCOMES = [
  "undecipherable",
  "already_done",
  "obsolete",
  "superseded",
  "needs_info",
  "pr_ready",
  "work_completed",
  "blocked",
  "busy",
] as const;
export const outcomeShape = oneOf(OUTCOMES);
export type Outcome = Infer<typeof outcomeShape>;

// ── Linear ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const attachmentShape = obj({ title: opt(str()), url: str() });

export const issueShape = obj({
  identifier: str(),
  title: str(),
  description: str(),
  status: str(),
  priority: int({ min: 0, max: 4 }),
  createdAt: str(),
  url: str(),
  gitBranchName: str(),
  attachments: arr(attachmentShape),
});
export type Issue = Infer<typeof issueShape>;

export const commentShape = obj({ id: str(), body: str(), createdAt: str() });
export type Comment = Infer<typeof commentShape>;

export const statusShape = obj({ id: str(), name: str() });
export type LinearStatus = Infer<typeof statusShape>;

export const issueSummaryShape = obj({
  identifier: str(),
  status: str(),
  priority: int({ min: 0, max: 4 }),
  createdAt: str(),
});
export type IssueSummary = Infer<typeof issueSummaryShape>;

// ── GitHub and git ──────────────────────────────────────────────────────────────────────────────────────────────

export const pullRequestRefShape = obj({
  url: str(),
  org: str(),
  repo: str(),
  number: int(),
});
export type PullRequestRef = Infer<typeof pullRequestRefShape>;

export const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"] as const;

export const pullRequestShape = obj({
  url: str(),
  org: str(),
  repo: str(),
  number: int(),
  state: oneOf(PULL_REQUEST_STATES),
  isDraft: bool(),
  headRef: str(),
  baseRef: str(),
});
export type PullRequest = Infer<typeof pullRequestShape>;

export const repositoryShape = obj({
  org: str(),
  name: str(),
  /** Absolute path of the local checkout. */
  checkout: str(),
  why: str(),
});
export type Repository = Infer<typeof repositoryShape>;

export const worktreeShape = obj({
  path: str(),
  branch: str(),
  /** The branch a PR from this worktree targets. */
  base: str(),
});
export type Worktree = Infer<typeof worktreeShape>;

export const publishedPullRequestShape = obj({ url: str(), number: int(), draft: bool() });
export type PublishedPullRequest = Infer<typeof publishedPullRequestShape>;

// ── Judgments ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What the /tickets pass answers. */
export const rewriteAnswerShape = refine(
  obj({ decipherable: bool(), description: str(), questions: arr(str({ min: 1 })) }),
  (answer) => {
    if (answer.decipherable && answer.description.trim() === "") return "a decipherable ticket needs its rewritten description";
    if (!answer.decipherable && answer.questions.length === 0) return "an undecipherable ticket needs the questions that block it";
    return undefined;
  },
);
export type RewriteAnswer = Infer<typeof rewriteAnswerShape>;

export const repositoryAnswerShape = obj({ repository: str(), why: str({ min: 1 }) });
export type RepositoryAnswer = Infer<typeof repositoryAnswerShape>;

export const ROOT_CAUSE_VERDICTS = ["real", "already_done", "obsolete", "superseded", "needs_info"] as const;

/** The pre-work adversarial review's verdict file. */
export const rootCauseVerdictShape = obj({
  verdict: oneOf(ROOT_CAUSE_VERDICTS),
  // Whether the checkout under review holds the work. False when the work lives outside it — a live host, a vendor
  // account, a money path, a doc — which is still real work: the run works it without the checkout instead.
  workInThisCheckout: dflt(bool(), true),
  rootCause: str(),
  summary: str({ min: 1 }),
  evidence: arr(str()),
  concerns: arr(str()),
  supersededBy: opt(str()),
  // A model answer often omits it: it only changes the outcome for `already_done`, so not closing is the safe reading.
  closeLinkedPullRequest: dflt(bool(), false),
});
export type RootCauseVerdict = Infer<typeof rootCauseVerdictShape>;

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;

export const findingShape = obj({
  severity: oneOf(SEVERITIES),
  location: str(),
  issue: str({ min: 1 }),
  fix: opt(str()),
});
export type Finding = Infer<typeof findingShape>;

export const REVIEW_VERDICTS = ["BLOCK", "CONCERNS", "CLEAN"] as const;

/** The post-work adversarial review's verdict file. */
export const changeVerdictShape = obj({
  verdict: oneOf(REVIEW_VERDICTS),
  summary: str({ min: 1 }),
  findings: arr(findingShape),
});
export type ChangeVerdict = Infer<typeof changeVerdictShape>;

export const IMPLEMENTATION_OUTCOMES = ["pr_ready", "already_done", "obsolete", "superseded", "needs_info", "blocked"] as const;

/** What the implementer answers when it stops. */
export const implementationShape = refine(
  obj({
    outcome: oneOf(IMPLEMENTATION_OUTCOMES),
    summary: str({ min: 1 }),
    concerns: arr(str()),
    evidence: arr(str()),
    supersededBy: opt(str()),
    closeLinkedPullRequest: dflt(bool(), false),
  }),
  (answer) =>
    answer.outcome === "blocked" && answer.concerns.length === 0
      ? "a blocked answer needs the concern that says what is missing and what would unblock it"
      : undefined,
);
export type Implementation = Infer<typeof implementationShape>;

/** The outcomes of working a ticket with no checkout behind it. */
export const REPOLESS_OUTCOMES = ["work_completed", "already_done", "obsolete", "superseded", "needs_info", "blocked"] as const;

/**
 * What the ticket worker answers when it works a ticket whose work has no repository: the deliverable itself is the
 * `summary`, and `evidence` carries the receipts for it.
 */
export const repolessWorkShape = refine(
  obj({
    outcome: oneOf(REPOLESS_OUTCOMES),
    summary: str({ min: 1 }),
    concerns: arr(str()),
    evidence: arr(str()),
    supersededBy: opt(str()),
    closeLinkedPullRequest: dflt(bool(), false),
  }),
  (answer) =>
    (answer.outcome === "blocked" || answer.outcome === "needs_info") && answer.concerns.length === 0
      ? `a ${answer.outcome} answer needs the concern that says what is missing and what would unblock it`
      : undefined,
);
export type RepolessWork = Infer<typeof repolessWorkShape>;

/** How a run ends: what is written to the ticket and to the linked PR. */
export const closingShape = obj({
  outcome: outcomeShape,
  summary: str(),
  concerns: arr(str()),
  evidence: arr(str()),
  supersededBy: opt(str()),
  closeLinkedPullRequest: bool(),
});
export type Closing = Infer<typeof closingShape>;

export const mergeReportShape = obj({ status: str(), reasons: arr(str()) });
export type MergeReport = Infer<typeof mergeReportShape>;

// ── Landing ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The capability that lands a pull request: a dependency bot's bump goes through `upgrade_dependency`, any other change through `make_pr_mergable`. */
export const LANDING_ROUTES = ["upgrade_dependency", "make_pr_mergable"] as const;

export const landingShape = obj({
  url: str(),
  route: oneOf(LANDING_ROUTES),
  state: str(),
  landed: bool(),
  reasons: arr(str()),
});
export type Landing = Infer<typeof landingShape>;

// ── The ticket run ──────────────────────────────────────────────────────────────────────────────────────────────

export const lockHolderShape = obj({ runId: str(), ticket: str() });
export type LockHolder = Infer<typeof lockHolderShape>;

/**
 * What every step of a ticket run reads and returns, what the checkpoint file stores, and what the run answers with.
 * `outcome` is set when the run has ended (an early end) or settled; `linearStatus` is the status the ticket was left in.
 * The workspace is never stored: it is the one `workspaceFor(ticket)` names.
 */
export const stateShape = obj({
  ticket: ticketShape,
  merge: bool(),
  runId: str(),
  issue: opt(issueShape),
  comments: arr(commentShape),
  linkedPulls: arr(pullRequestRefShape),
  /** The ticket body the work is done from: the /tickets rewrite of it, which is never saved to the ticket. */
  body: str(),
  /** Why no repository was identified, when the ticket's work has none; the repo-less worker is told it. */
  noRepositoryWhy: opt(str()),
  repository: opt(repositoryShape),
  linkedPullRequest: opt(pullRequestShape),
  worktree: opt(worktreeShape),
  rootCause: opt(rootCauseVerdictShape),
  implementation: opt(implementationShape),
  /** What working the ticket without a checkout answered, when the work has no repository or lives outside the checkout. */
  repolessWork: opt(repolessWorkShape),
  /** The change review's findings the next implementation round is handed. */
  findings: arr(findingShape),
  changeReview: opt(changeVerdictShape),
  rounds: int({ min: 0 }),
  pullRequest: opt(publishedPullRequestShape),
  closing: opt(closingShape),
  outcome: opt(outcomeShape),
  /** The live run that holds the machine-wide lock, when this run answered `busy`. */
  busyHeldBy: opt(lockHolderShape),
  linearStatus: opt(str()),
  closedPullRequests: arr(str()),
  /** Where the run's ready pull request stands after its landing attempt; absent when the run opened none (or only a draft). */
  landing: opt(landingShape),
  /** `landing.landed` on its own, for a reader that wants one boolean: true only for a merge or a merge-queue hold. */
  prLanded: opt(bool()),
});
export type State = Infer<typeof stateShape>;

export const initialState = (input: { ticket: string; merge: boolean; runId: string }): State => ({
  ticket: input.ticket,
  merge: input.merge,
  runId: input.runId,
  comments: [],
  linkedPulls: [],
  body: "",
  findings: [],
  rounds: 0,
  closedPullRequests: [],
});

export type { Shape };
