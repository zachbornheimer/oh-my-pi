/** The omp role a fix round runs on. */
export type Role = "@task";

/** What settled means: `approved` is mergeable plus reviewers satisfied; `mergeable` leaves out what only reviewers decide. */
export type Target = "mergeable" | "approved";

export interface Thread {
  id: string;
  path: string;
  url: string;
  author: string;
  body: string;
}

/** A human comment or review body that no pushed fix follows. */
export interface Note {
  id: string;
  source: "comment" | "review";
  author: string;
  /** The author can push (OWNER, MEMBER or COLLABORATOR). The agent is only shown these. */
  trusted: boolean;
  body: string;
  at: string;
}

export interface Reviewer {
  login: string;
  /** The state of this reviewer's latest review. */
  state: string;
  /** The commit that review is on. */
  commitSha: string;
  submittedAt: string;
}

export interface Checks {
  verdict: "green" | "red" | "pending" | "no-checks";
  failed: string[];
  pending: string[];
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** Everything rule 5 asks about one pull request head, read once. Facts only: no judgment. */
export interface Facts {
  prUrl: string;
  /** owner/name */
  repo: string;
  number: number;
  baseRef: string;
  state: PrState;
  isDraft: boolean;
  headRef: string;
  headSha: string;
  /** When the current head reached GitHub. */
  headPushedAt: string;
  observedAt: string;
  author: string;
  viewer: string;
  viewerCanPush: boolean;
  isCrossRepository: boolean;
  /** owner/name of the head repository when on a fork. */
  headRepo?: string;
  /** GitHub's reviewDecision; empty when it has none. */
  reviewDecision: string;
  mergeStateStatus: string;
  unresolvedThreads: Thread[];
  openComments: Note[];
  reviewers: Reviewer[];
  checks: Checks;
}

export interface Verdict {
  kind: "settled" | "working" | "blocked" | "merged" | "closed";
  /** The head the verdict is about, and the one a merge must match. */
  headSha: string;
  /** Why it is not settled; empty when it is. */
  reasons: string[];
}

/**
 * `merge-base` and `conflict` are shown to the model as text only: a text edit cannot merge a branch, so a prompt that
 * cannot fix them says so and the run ends `impossible`. `push-refused` is what refused the host's push of the last
 * round (a pre-push hook or GitHub), so the next round fixes it instead of repeating commits that cannot be pushed.
 */
export type Issue =
  | { kind: "merge-base"; baseRef: string; why: string }
  | { kind: "conflict"; baseRef: string; files: string[] }
  | { kind: "thread"; id: string; path: string; author: string; body: string }
  | { kind: "comment"; id: string; author: string; body: string }
  | { kind: "failed-check"; name: string }
  | { kind: "push-refused"; output: string };

export interface RoundRecord {
  number: number;
  role: Role;
  status: "pushed" | "failed";
  reason: string;
  fromSha: string;
  toSha: string | null;
  commits: number;
  /** What refused this round's push, as git reported it; empty otherwise. */
  refusal: string;
}

/** One round's work in the checkout, before the host has pushed it. */
export interface Attempt {
  number: number;
  role: Role;
  cwd: string;
  fromSha: string;
  commits: number;
  /** Set when the round cannot be pushed; the reason it failed. */
  problem: string;
}

/**
 * How a run ended: `done` (the pull request is mergeable), `impossible` (no round can settle it: closed, a draft with
 * nothing left to fix, no push access with work left, or the model says the cause is outside this repository), `spent`
 * (a limit of `PR_BUDGET` or the settle wait ran out). `working` is a run that has not ended.
 */
export const STATUSES = ["working", "done", "merged", "impossible", "spent"] as const;
export type Status = (typeof STATUSES)[number];

/** What a caller passes. */
export interface Input {
  prUrl: string;
  /** The failed check the caller already read: round 1's prompt. */
  check: { check: string; log: string };
}

/** What each step hands the next, and what the run returns. */
export interface State {
  prUrl: string;
  target: Target;
  status: Status;
  facts?: Facts;
  verdict?: Verdict;
  issues: Issue[];
  reasons: string[];
  attempt: Attempt | null;
  rounds: RoundRecord[];
  /** A fix round this pass ran made `facts` and `verdict` out of date. */
  stale: boolean;
  /** The run's first reading, from which its wall-clock budget is measured. */
  startedAt: string;
  headSha: string;
  /** The last round's summary: what the model changed, or why it could not. */
  summary: string;
  /** Every file edited, over all rounds. */
  changed: string[];
}
