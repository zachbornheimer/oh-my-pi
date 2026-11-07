/** The shapes the relay moves between its steps. Validators for the model-written ones live in `records.ts`. */

export type WorkspaceStatuses = {
  ready: string;
  notReady: string;
  inProgress: string;
  pullRequest: string;
  done: string;
  canceled: string;
  duplicate: string;
  triage?: string;
  unreviewed?: string;
};

/** One Linear workspace: its team key and the statuses it names for each role. */
export type Workspace = {
  team: string;
  /** The GitHub organisations the workspace's repositories live in. */
  orgs: string[];
  statuses: WorkspaceStatuses;
};

export type Attachment = { title?: string | null; url: string };

export type Issue = {
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  createdAt: string;
  url: string;
  gitBranchName: string;
  attachments: Attachment[];
};

export type Comment = { id: string; body: string; createdAt: string };
export type LinearStatus = { id: string; name: string };

export type PullRequestRef = { url: string; org: string; repo: string; number: number };
export type PullRequest = PullRequestRef & {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRef: string;
  baseRef: string;
};

export const OUTCOMES = [
  "undecipherable",
  "already_done",
  "obsolete",
  "superseded",
  "needs_info",
  "work_completed",
  "blocked",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** How a run ends: what is written to the ticket and to the linked pull requests. */
export type Closing = {
  outcome: Outcome;
  summary: string;
  concerns: string[];
  evidence: string[];
  supersededBy?: string;
  closeLinkedPullRequest: boolean;
};

export type RewriteAnswer = { decipherable: boolean; description: string; questions: string[] };

export const ROOT_CAUSE_VERDICTS = ["real", "already_done", "obsolete", "superseded", "needs_info"] as const;
export type RootCauseVerdict = {
  verdict: (typeof ROOT_CAUSE_VERDICTS)[number];
  workInThisCheckout: boolean;
  rootCause: string;
  summary: string;
  evidence: string[];
  concerns: string[];
  supersededBy?: string;
  closeLinkedPullRequest: boolean;
};

export const WORK_OUTCOMES = ["work_completed", "already_done", "obsolete", "superseded", "needs_info", "blocked"] as const;
export type Used = { tools: string[]; skills: string[]; workflows: string[] };
export type WorkRecord = {
  outcome: (typeof WORK_OUTCOMES)[number];
  summary: string;
  used: Used;
  concerns: string[];
  evidence: string[];
  supersededBy?: string;
  closeLinkedPullRequest: boolean;
  pullRequests: PullRequestRef[];
};

export const IMPROVEMENTS = ["none", "landed"] as const;
export type Improvement = {
  improvement: (typeof IMPROVEMENTS)[number];
  summary: string;
  evidence: string[];
  pullRequests: PullRequestRef[];
};

/** What the run answers with: every step's record, and the outcome and status the ticket was left in. */
export type State = {
  ticket: string;
  workspace?: Workspace;
  runId: string;
  issue?: Issue;
  comments: Comment[];
  linkedPulls: PullRequestRef[];
  /** The ticket body the work is done from: the /tickets rewrite of it, which is never saved to the ticket. */
  body: string;
  rewrite?: RewriteAnswer;
  rootCause?: RootCauseVerdict;
  work?: WorkRecord;
  improvement?: Improvement;
  /** Why the tooling pass's answer could not be read; set instead of `improvement`. */
  toolingError?: string;
  closing?: Closing;
  outcome?: Outcome;
  linearStatus?: string;
  closedPullRequests: string[];
};

export type LinearPort = {
  getIssue(workspace: Workspace, ticket: string): Promise<Issue>;
  listComments(workspace: Workspace, ticket: string): Promise<Comment[]>;
  listStatuses(workspace: Workspace): Promise<LinearStatus[]>;
  saveIssue(workspace: Workspace, input: { ticket: string; stateId?: string; duplicateOf?: string }): Promise<void>;
  saveComment(workspace: Workspace, input: { ticket: string; body: string }): Promise<void>;
};

export type GitHubPort = {
  readPullRequest(url: string): Promise<PullRequest>;
  closePullRequest(input: { url: string; comment: string }): Promise<void>;
};

/** Every effect the relay has. The live set is `live_ports.ts`; tests supply fakes. */
export type RelayPorts = {
  linear: LinearPort;
  github: GitHubPort;
  /** Waits between a write's read-back attempts: Linear's reads lag its writes. */
  sleep(ms: number): Promise<void>;
  /** The text of an installed skill's SKILL.md. */
  readSkill(name: string): Promise<string>;
  /** One question to a model; answers its raw text. `field` names the question for the record. */
  ask(input: { field: string; prompt: string }): Promise<string>;
  /** A headless adversarial review (no checkout); answers the text of the verdict file at `verdictPath`. */
  review(input: { prompt: string; verdictPath: string }): Promise<string>;
  /** Takes one pull request red in CI and answers whether it could be greened, with a report. */
  fixRedCi(input: { prUrl: string }): Promise<{ green: boolean; report: string }>;
  /** One headless omp call that works the ticket; answers its final text. */
  work(input: { prompt: string }): Promise<string>;
  /** One headless omp call in the tooling checkout that improves the tooling; answers its final text. */
  improve(input: { prompt: string }): Promise<string>;
};
