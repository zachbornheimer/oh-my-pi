import type { ROUND_ROLES } from "./constants.js";

export type Role = (typeof ROUND_ROLES)[number];

/** What settled means: `approved` is mergeable plus reviewers satisfied; `mergeable` leaves out what only reviewers decide. This tool aims at `mergeable`. */
export type Target = "mergeable" | "approved";

/**
 * One deterministic check a caller adds to the standard criteria. Only a `failed` gate blocks: `passed` and
 * `not_proven` never do.
 */
export interface Gate {
  name: string;
  verdict: "passed" | "failed" | "not_proven";
  observed: string;
}

/**
 * A caller's own exit criteria, as a function of the reading: evaluated again on every reading of an open head, so a
 * gate that a fix round changes is judged on the head the round pushed. A gate that throws fails the run; it is never
 * read as a pass. A failed gate is an issue the next round works.
 */
export type PrGates = (facts: Facts) => readonly Gate[] | Promise<readonly Gate[]>;

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
  /** The head the verdict is about. */
  headSha: string;
  /** Why it is not settled; empty when it is. */
  reasons: string[];
}

/**
 * `merge-base` is host work: the fix step merges `origin/<baseRef>` into the head before the agent starts, and the agent
 * never sees it. If git reports conflicts, the issue the agent gets in its place is `conflict`: the merge is started,
 * these files are unmerged, and resolving them and committing the merge is the agent's job. `push-refused` is what
 * refused the host's push of the last round (a pre-push hook or GitHub), so the next round fixes it instead of
 * repeating commits that cannot be pushed. `gate` is a caller's check that failed (`Gate`): `name` is the check and
 * `observed` is what it saw.
 */
export type Issue =
  | { kind: "merge-base"; baseRef: string; why: string }
  | { kind: "conflict"; baseRef: string; files: string[] }
  | { kind: "thread"; id: string; path: string; author: string; body: string }
  | { kind: "comment"; id: string; author: string; body: string }
  | { kind: "failed-check"; name: string }
  | { kind: "push-refused"; output: string }
  | { kind: "gate"; name: string; observed: string };

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

/** The agent's work in one round, before the host has pushed it. */
export interface Attempt {
  number: number;
  role: Role;
  cwd: string;
  fromSha: string;
  commits: number;
  /** The agent's exit status; -1 when it did not run or crashed. */
  agentStatus: number;
  /** Set when the round cannot be pushed; the reason it failed. */
  problem: string;
}

/**
 * How a run ended: `done` (settled for the target: every standard criterion holds and no caller gate failed),
 * `impossible` (no round can settle it: closed, a draft with nothing left to fix, no push access with work left, or
 * only a person can act), `spent` (a limit of `PR_BUDGET` or the settle wait ran out), `merged` (the pull request was
 * already merged, or was merged by someone else while the run read it; this tool never merges). `working` is a run
 * that has not ended; `runPrLoop` never returns it.
 */
export const STATUSES = ["working", "done", "merged", "impossible", "spent"] as const;
export type Status = (typeof STATUSES)[number];

/** What a caller passes. */
export interface Input {
  prUrl: string;
  gates?: PrGates;
}

/** What each step hands the next, and what the run returns. */
export interface State {
  prUrl: string;
  target: Target;
  status: Status;
  facts?: Facts;
  /** The caller's gates as `facts` was last read with them; empty when the pull request was not open. */
  gates: readonly Gate[];
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
}
