import type { FactoryLedger } from "./run_ledger.js";
import type {
  Comment,
  Issue,
  IssueSummary,
  LinearStatus,
  LockHolder,
  MergeReport,
  PullRequest,
  Worktree,
} from "./schemas.js";
import type { Workspace } from "./workspaces.js";

/** One Linear workspace, through that workspace's own API key. */
export type LinearPort = {
  getIssue(workspace: Workspace, ticket: string): Promise<Issue>;
  /** Every comment of the ticket, oldest first. */
  listComments(workspace: Workspace, ticket: string): Promise<Comment[]>;
  /** Every status of the workspace's team, with its id. */
  listStatuses(workspace: Workspace): Promise<LinearStatus[]>;
  /** Every issue of the workspace's team now in the named status, or only those in `project` when one is named. */
  listIssues(workspace: Workspace, status: string, project?: string): Promise<IssueSummary[]>;
  saveIssue(
    workspace: Workspace,
    input: { ticket: string; description?: string; stateId?: string; duplicateOf?: string },
  ): Promise<void>;
  saveComment(workspace: Workspace, input: { ticket: string; body: string }): Promise<void>;
};

export type GitHubPort = {
  /** Any `github.com/<org>/<repo>/pull/<n>` URL, whatever the organisation. */
  readPullRequest(url: string): Promise<PullRequest>;
  /** The login of the pull request's author, as GitHub names it (`app/renovate`, `octocat`). */
  readPullRequestAuthor(url: string): Promise<string>;
  /** Opens a PR from `head` into `base` in `org/repo` and answers its URL. */
  createPullRequest(input: {
    org: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<string>;
  /** Takes a draft PR out of draft. */
  markPullRequestReady(url: string): Promise<void>;
  /** Closes the PR with `comment` as the reason. */
  closePullRequest(input: { url: string; comment: string }): Promise<void>;
};

/** A repository checked out on this machine. */
export type Checkout = {
  org: string;
  repo: string;
  path: string;
};

/**
 * A checkout or worktree that cannot be made because the repository is not there for this account: GitHub cannot resolve
 * it, so neither a clone nor a fetch of it is possible. Not an operational fault (a repository that does not exist is no
 * repository), and the factory answers it as `blocked` rather than failing the run. `reason` is the line GitHub said it
 * in: the diagnostic, not the `Command failed: …` header above it.
 */
export class RepositoryUnavailableError extends Error {
  constructor(
    readonly repository: string,
    readonly reason: string,
  ) {
    super(`${repository} cannot be checked out: ${reason}`);
    this.name = "RepositoryUnavailableError";
  }
}

/** Local checkouts, worktrees and the pushes of one ticket's branch. */
export type RepoPort = {
  /** The repositories checked out under the workspace's roots, by GitHub name. */
  listCheckouts(workspace: Workspace): Promise<Checkout[]>;
  /**
   * The local checkout of `repo` (of that organisation when one is named), cloned into the root its organisation belongs
   * to when there is none.
   */
  ensureCheckout(workspace: Workspace, repo: { name: string; org?: string }): Promise<Checkout>;
  /**
   * A worktree of `checkout` on `branch`: the branch is continued when it exists (a linked PR's head, or an earlier run's),
   * otherwise cut from `base`, the default branch when none is given. Answers the branch a PR from it targets.
   */
  openWorktree(input: { checkout: string; ticket: string; branch: string; base?: string }): Promise<Worktree>;
  /** Whether a worktree opened earlier is still on disk: a resumed run re-opens it when it is not. */
  worktreeExists(path: string): Promise<boolean>;
  /** Commits whatever is uncommitted; answers whether a commit was made. */
  commitLeftovers(input: { worktree: string; message: string }): Promise<boolean>;
  /** How many commits `HEAD` has that `origin/<base>` does not. */
  commitsAhead(input: { worktree: string; base: string }): Promise<number>;
  push(input: { worktree: string; branch: string }): Promise<void>;
};

export type UpgradeReport = { verdict: "ready" | "needs_work" | "skipped"; reasons: string[] };

export type FactoryPorts = {
  linear: LinearPort;
  github: GitHubPort;
  repos: RepoPort;
  /** Waits between a write's read-back attempts: Linear's reads lag its writes. Rejects when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  /** The text of an installed skill's SKILL.md. */
  readSkill(name: string): Promise<string>;
  /** One question to a model; answers its raw text. `field` names the question for the record. */
  ask(input: { field: string; prompt: string }): Promise<string>;
  /** The implementer, a full omp session bound to `worktree`, answering the final text of its run. */
  implement(input: { worktree: string; branch: string; prompt: string }): Promise<string>;
  /**
   * A headless adversarial review in `worktree`, or in a scratch directory when the ticket has no checkout; answers the
   * text of the verdict file at `verdictPath`.
   */
  review(input: { worktree?: string; prompt: string; verdictPath: string }): Promise<string>;
  /**
   * Works a ticket whose work has no checkout behind it — web research, the webmaster flows for sites and hosts, a
   * Linear write for what the ticket asks to record — answering the final text of its run.
   */
  workWithoutCheckout(input: { prompt: string }): Promise<string>;
  /** The `make_pr_mergable` omp tool on one pull request. */
  makePrMergable(input: { prUrl: string; merge: boolean }): Promise<MergeReport>;
  /** The `upgrade_dependency` omp tool on a dependency bot's pull request: `ready` once it is labeled checked and armed for automerge. */
  upgradeDependency(input: { prUrl: string }): Promise<UpgradeReport>;
  /** Takes one pull request red in CI and answers whether the `fix_red_ci` omp tool could green it, with its report. */
  fixRedCi(input: { prUrl: string }): Promise<{ green: boolean; report: string }>;
  /**
   * The one-ticket-at-a-time lock. `acquire` answers the live run that holds it when another run does, so `busy` can
   * name it; `release` frees only this run's.
   */
  lock: {
    acquire(input: { runId: string; ticket: string }): Promise<{ held: boolean; holder?: LockHolder }>;
    release(runId: string): Promise<void>;
  };
  /** The append-only record of this machine's factory runs: an effect, so a test injects its own. */
  ledger: FactoryLedger;
  /** The per-step checkpoint files a rerun skips finished steps from. */
  checkpoints: import("./checkpoint.js").Checkpoints;
  /** The clock, for a checkpoint's age. */
  now(): number;
};

export type { LockHolder };
