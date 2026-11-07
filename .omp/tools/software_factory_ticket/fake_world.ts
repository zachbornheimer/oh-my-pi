import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "./checkpoint.js";
import { type FactoryPorts, RepositoryUnavailableError } from "./ports.js";
import { FactoryRunLedger } from "./run_ledger.js";
import type {
  Comment,
  Implementation,
  RepolessWork,
  Issue,
  PullRequest,
  RewriteAnswer,
  RootCauseVerdict,
  ChangeVerdict,
} from "./schemas.js";
import { primaryRoot, WORKSPACES, type Workspace, workspaceFor } from "./workspaces.js";

/**
 * The world of one factory run, in memory: the Linear workspaces the factory knows, GitHub, a local git with both roots'
 * checkouts, the omp reviewer, Coder, a model that answers the two questions, and the lock. Nothing here touches
 * the network, a repository or a process. A test scripts the answers (`rewrite`, `repositoryReply`, `rootCause`,
 * `implementations`, `changeReviews`) and then reads what the run did: `events` in order, `linearCalls` (with the workspace
 * server each one went to), `linearWrites`, `pulls`, `worktrees`, `pushes`, `prompts`.
 */

export const ORG = "Software-Automation-Holdings-LLC";
export const PERSONAL_ORG = "zachbornheimer";

/** The repositories each organisation has checked out in the fake world. */
const FAKE_REPOS: Record<string, string[]> = {
  [ORG]: ["widgets", "gadgets"],
  [PERSONAL_ORG]: ["capabilities", "agentmux"],
};
export const pullUrl = (org: string, repo: string, number: number) => `https://github.com/${org}/${repo}/pull/${number}`;

/** The local path a repository of the ticket's workspace has. */
export function checkoutPath(identifier: string, repo: string): string {
  return join(primaryRoot(workspaceFor(identifier)), repo);
}

export type FakeIssue = Issue & { comments: Comment[]; duplicateOf?: string; project?: string };

/** The workspace a ticket identifier names, or nothing for a prefix the factory does not know. */
function workspaceOrNothing(identifier: string): Workspace | undefined {
  const team = identifier.slice(0, Math.max(0, identifier.indexOf("-")));
  return WORKSPACES.find((workspace) => workspace.team === team);
}

export const implemented = (overrides: Partial<Implementation> = {}): Implementation => ({
  outcome: "pr_ready",
  summary: "Fixed the quote total.",
  concerns: [],
  evidence: ["src/quote.ts:42"],
  closeLinkedPullRequest: false,
  ...overrides,
});

export const blocking = (issue: string): ChangeVerdict => ({
  verdict: "BLOCK",
  summary: "The change loses data.",
  findings: [{ severity: "blocker", location: "src/quote.ts:42", issue }],
});

export const clean: ChangeVerdict = { verdict: "CLEAN", summary: "No findings.", findings: [] };

export class FakeFactory {
  readonly events: string[] = [];
  /** Every Linear call, with the workspace server it was made against. */
  readonly linearCalls: { team: string; tool: string; ticket?: string }[] = [];
  readonly linearWrites: string[] = [];
  readonly issues = new Map<string, FakeIssue>();
  readonly pulls = new Map<string, PullRequest>();
  readonly created: {
    org: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
    url: string;
  }[] = [];
  readonly closed: { url: string; comment: string }[] = [];
  readonly worktrees: { checkout: string; ticket: string; branch: string; base?: string }[] = [];
  readonly pushes: string[] = [];
  readonly prompts: { field: string; prompt: string }[] = [];
  readonly implementPrompts: string[] = [];
  readonly reviewPrompts: string[] = [];
  readonly mergeRuns: { prUrl: string; merge: boolean }[] = [];
  /** Every pull request the run handed to fix_red_ci, in order. */
  readonly fixRedCiRuns: string[] = [];
  /** The repositories cloned, as `<org>/<repo>`, and the root each was cloned into. */
  readonly clones: string[] = [];
  /** Repositories, as `<org>/<repo>`, GitHub answers 404 for: a clone of one cannot be made. */
  readonly unavailableRepos: string[] = [];
  /** Repositories, as `<org>/<repo>`, whose checkout exists but whose upstream is gone: a worktree of one cannot be opened. */
  readonly unavailableWorktrees: string[] = [];
  /** The local checkouts, by the root they live under: one workspace's roots hold the repositories of its organisations. */
  readonly localRepos: { root: string; org: string; repo: string }[] = WORKSPACES.flatMap((workspace) =>
    workspace.orgs.flatMap((org) =>
      (FAKE_REPOS[org] ?? []).map((repo) => ({ root: primaryRoot(workspace), org, repo }))
    )
  );

  /** Linear accepts a write but stores nothing: the read-back disagrees. Both writes, or only the comments. */
  dropLinearWrites = false;
  dropCommentWrites = false;
  /**
   * How many reads after a write still answer the state before it, as Linear's lagging read replica does. The read-back the
   * workflow takes must be re-read until it catches up; `Math.infinity` never catches up.
   */
  staleReads = 0;
  /** The reads the last write left answering the pre-write state, and what they answer. */
  staleIssue: { issue: Issue; reads: number } | undefined;
  staleComments: { comments: Comment[]; reads: number } | undefined;
  /** Every wait the run asked for, in milliseconds: the read-back's interval, without waiting in the test. */
  readonly sleeps: number[] = [];
  lockHolder: string | undefined;
  /** The ticket the live lock holder holds, when another run answers busy and must name it. */
  lockHolderTicket = "SAH-9";
  /** Held now by a run, and the most that were held at once. */
  held = 0;
  maxHeld = 0;
  /** Commits the branch has ahead of base: what the code-improver "made". */
  ahead = 1;
  /** Whether the worktree has uncommitted changes the workflow must commit. */
  leftovers = false;
  rewrite: (issue: Issue) => RewriteAnswer = (issue) => ({
    decipherable: true,
    description: `## Outcome\n${issue.title}, rewritten.`,
    questions: [],
  });
  /** The Repository answer: the record the question asks for, or raw prose when a model answered in the wrong shape. */
  repositoryReply: { repository: string; why: string } | string = { repository: "widgets", why: "The ticket names the widgets quote page." };
  rootCause: RootCauseVerdict = {
    verdict: "real",
    workInThisCheckout: true,
    rootCause: "src/quote.ts:42 sums the discount twice.",
    summary: "A real defect.",
    evidence: ["src/quote.ts:42"],
    concerns: [],
    closeLinkedPullRequest: false,
  };
  readonly implementations: Implementation[] = [];
  /** What working a ticket without a checkout answers, scripted: one answer per repo-less run. */
  readonly repolessWorks: RepolessWork[] = [];
  readonly workPrompts: string[] = [];
  readonly changeReviews: ChangeVerdict[] = [];
  /** What the fix_red_ci port answers, scripted: green, or the not-green report a run settles blocked with. */
  fixRedCiReport: { green: boolean; report: string } = { green: true, report: "The pull request is mergeable." };
  mergeReport = { status: "done", reasons: ["settled approved"] };
  /** The login that opened each pull request, by url; a url not named here was opened by a person. */
  readonly authors = new Map<string, string>();
  /** What the upgrade_dependency port answers, scripted. */
  upgradeReport: { verdict: "ready" | "needs_work" | "skipped"; reasons: string[] } = { verdict: "ready", reasons: [] };
  readonly upgradeRuns: string[] = [];
  skillText = "TICKETS SKILL BODY";
  /** The per-step checkpoint files, by ticket, and every save the run made. */
  readonly checkpointStore = new Map<string, Checkpoint>();
  readonly checkpointSaves: { ticket: string; steps: string[]; finished: boolean }[] = [];
  /** Worktree paths a test removes from disk between two runs. */
  readonly removedWorktrees = new Set<string>();
  /** The clock a checkpoint's age is judged by, in milliseconds. */
  clockMs = 1_000_000;
  /** Makes the named fake throw once when called: `implement`, `review`, `fixRedCi`, `saveComment`. */
  failOnce: string | undefined;
  /** Awaited inside the model question, so two runs that overlap would interleave here. */
  askDelayMs = 3;

  addIssue(identifier: string, overrides: Partial<FakeIssue> = {}): FakeIssue {
    const statuses = workspaceOrNothing(identifier)?.statuses;
    const issue: FakeIssue = {
      identifier,
      title: `Title of ${identifier}`,
      description: `The quote page for ${identifier} is wrong.`,
      status: statuses?.triage ?? statuses?.unreviewed ?? "Triage",
      priority: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      url: `https://linear.app/sah/issue/${identifier}`,
      gitBranchName: identifier.toLowerCase(),
      attachments: [],
      comments: [],
      ...overrides,
    };
    this.issues.set(identifier, issue);
    return issue;
  }

  addPull(org: string, repo: string, number: number, overrides: Partial<PullRequest> = {}): PullRequest {
    const url = pullUrl(org, repo, number);
    const pull: PullRequest = {
      url,
      org,
      repo,
      number,
      state: "OPEN",
      isDraft: false,
      headRef: `feature-${number}`,
      baseRef: "main",
      ...overrides,
    };
    this.pulls.set(url, pull);
    return pull;
  }

  /** Throws once when the named fake is the one a test scripted to fail. */
  private maybeFail(name: string): void {
    if (this.failOnce === name) {
      this.failOnce = undefined;
      throw new Error(`the fake ${name} failed`);
    }
  }

  issue(identifier: string): FakeIssue {
    const found = this.issues.get(identifier);
    if (found === undefined) throw new Error(`the fake workspace has no ${identifier}`);
    return found;
  }

  /** Every comment on the ticket, in the order posted. */
  commentsOn(identifier: string): string[] {
    return this.issue(identifier).comments.map((comment) => comment.body);
  }

  /** A Linear call is only ever made against the workspace that holds the ticket, as the live port's server routing must be. */
  private assertInWorkspace(workspace: Workspace, ticket: string): void {
    const holder = workspaceOrNothing(ticket);
    if (holder?.team !== workspace.team) throw new Error(`${ticket} is not a ${workspace.team} ticket`);
  }

  /**
   * This world's own run ledger, in a temp file. A test that runs the real ticket workflow records here, so a test
   * run can never append to the production record (`~/.local/state/capability-replicas/factory-runs.jsonl`).
   */
  readonly ledger = new FactoryRunLedger(join(mkdtempSync(join(tmpdir(), "fake-factory-ledger-")), "factory-runs.jsonl"));

  ports(): FactoryPorts {
    const note = (workspace: Workspace, tool: string, ticket?: string) => {
      this.linearCalls.push({ team: workspace.team, tool, ...(ticket === undefined ? {} : { ticket }) });
    };
    return {
      ledger: this.ledger,
      linear: {
        getIssue: async (workspace, ticket) => {
          this.assertInWorkspace(workspace, ticket);
          note(workspace, "getIssue", ticket);
          this.events.push(`linear.getIssue ${ticket}`);
          if (this.staleIssue !== undefined && this.staleIssue.reads > 0) {
            this.staleIssue.reads -= 1;
            return structuredClone(this.staleIssue.issue);
          }
          const { comments: _comments, duplicateOf: _duplicateOf, ...issue } = this.issue(ticket);
          return structuredClone(issue);
        },
        listComments: async (workspace, ticket) => {
          note(workspace, "listComments", ticket);
          if (this.staleComments !== undefined && this.staleComments.reads > 0) {
            this.staleComments.reads -= 1;
            return structuredClone(this.staleComments.comments);
          }
          return structuredClone(this.issue(ticket).comments);
        },
        listStatuses: async (workspace) => {
          note(workspace, "listStatuses");
          return Object.values(workspace.statuses)
            .filter((name): name is string => name !== undefined)
            .map((name) => ({ id: `id:${name}`, name }));
        },
        listIssues: async (workspace, status, project?: string) => {
          note(workspace, "listIssues");
          this.events.push(`linear.listIssues ${status}${project === undefined ? "" : ` project=${project}`}`);
          return [...this.issues.values()]
            .filter(
              (issue) =>
                workspaceOrNothing(issue.identifier)?.team === workspace.team
                && issue.status === status
                && (project === undefined || issue.project === project),
            )
            .map(({ identifier, status: current, priority, createdAt }) => ({ identifier, status: current, priority, createdAt }));
        },
        saveIssue: async (workspace, input) => {
          this.assertInWorkspace(workspace, input.ticket);
          note(workspace, "saveIssue", input.ticket);
          const event = `linear.saveIssue ${input.ticket} ${JSON.stringify({ description: input.description, stateId: input.stateId, duplicateOf: input.duplicateOf })}`;
          this.events.push(event);
          this.linearWrites.push(event);
          if (this.dropLinearWrites) return;
          const issue = this.issue(input.ticket);
          if (this.staleReads > 0) {
            const { comments: _comments, duplicateOf: _duplicateOf, ...before } = issue;
            this.staleIssue = { issue: structuredClone(before), reads: this.staleReads };
          }
          if (input.description !== undefined) issue.description = input.description;
          if (input.duplicateOf !== undefined) issue.duplicateOf = input.duplicateOf;
          if (input.stateId !== undefined) issue.status = input.stateId.replace(/^id:/, "");
        },
        saveComment: async (workspace, input) => {
          this.assertInWorkspace(workspace, input.ticket);
          note(workspace, "saveComment", input.ticket);
          const event = `linear.saveComment ${input.ticket}`;
          this.events.push(event);
          this.linearWrites.push(event);
          if (this.dropLinearWrites || this.dropCommentWrites) return;
          const issue = this.issue(input.ticket);
          if (this.staleReads > 0) this.staleComments = { comments: structuredClone(issue.comments), reads: this.staleReads };
          issue.comments.push({ id: `c${issue.comments.length + 1}`, body: input.body, createdAt: new Date(issue.comments.length * 1000).toISOString() });
        },
      },
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      github: {
        readPullRequestAuthor: async (url) => this.authors.get(url) ?? "octocat",
        readPullRequest: async (url) => {
          const found = this.pulls.get(url);
          if (found === undefined) throw new Error(`the fake GitHub has no ${url}`);
          return { ...found };
        },
        createPullRequest: async (input) => {
          this.events.push(`gh.createPullRequest ${input.head} draft=${input.draft}`);
          const number = 100 + this.created.length;
          const url = pullUrl(input.org, input.repo, number);
          this.created.push({ ...input, url });
          this.pulls.set(url, {
            url,
            org: input.org,
            repo: input.repo,
            number,
            state: "OPEN",
            isDraft: input.draft,
            headRef: input.head,
            baseRef: input.base,
          });
          return url;
        },
        markPullRequestReady: async (url) => {
          this.events.push(`gh.markPullRequestReady ${url}`);
          this.pulls.get(url)!.isDraft = false;
        },
        closePullRequest: async (input) => {
          this.events.push(`gh.closePullRequest ${input.url}`);
          this.closed.push(input);
          this.pulls.get(input.url)!.state = "CLOSED";
        },
      },
      repos: {
        listCheckouts: async (workspace) => {
          return this.localRepos
            .filter((checkout) => workspace.roots.includes(checkout.root))
            .map((checkout) => ({ org: checkout.org, repo: checkout.repo, path: join(checkout.root, checkout.repo) }));
        },
        ensureCheckout: async (workspace, repo) => {
          const known = this.localRepos.find(
            (checkout) =>
              workspace.roots.includes(checkout.root) && checkout.repo === repo.name && (repo.org === undefined || checkout.org === repo.org),
          );
          if (known !== undefined) return { org: known.org, repo: repo.name, path: join(known.root, repo.name) };
          const [workspaceOrg] = workspace.orgs;
          const org = repo.org ?? workspaceOrg;
          if (org === undefined) throw new Error(`the ${workspace.team} workspace has no organisation to clone ${repo.name} from`);
          if (this.unavailableRepos.includes(`${org}/${repo.name}`)) {
            throw new RepositoryUnavailableError(
              `${org}/${repo.name}`,
              `GraphQL: Could not resolve to a Repository with the name '${org}/${repo.name}'. (repository)`,
            );
          }
          const root = primaryRoot(workspace);
          this.clones.push(`${org}/${repo.name} -> ${root}`);
          this.localRepos.push({ root, org, repo: repo.name });
          return { org, repo: repo.name, path: join(root, repo.name) };
        },
        openWorktree: async (input) => {
          this.events.push(`git.openWorktree ${input.branch}`);
          const local = this.localRepos.find((checkout) => join(checkout.root, checkout.repo) === input.checkout);
          const repository = local === undefined ? input.checkout : `${local.org}/${local.repo}`;
          if (this.unavailableWorktrees.includes(repository)) {
            throw new RepositoryUnavailableError(repository, "remote: Repository not found.");
          }
          this.worktrees.push(input);
          const repo = input.checkout.split("/").at(-1)!;
          return { path: `/worktrees/${repo}-${input.ticket.toLowerCase()}`, branch: input.branch, base: input.base ?? "main" };
        },
        worktreeExists: async (path) => {
          this.events.push(`git.worktreeExists ${path}`);
          return !this.removedWorktrees.has(path);
        },
        commitLeftovers: async () => {
          this.events.push("git.commitLeftovers");
          const had = this.leftovers;
          this.leftovers = false;
          return had;
        },
        commitsAhead: async () => {
          return this.ahead;
        },
        push: async ({ branch }) => {
          this.events.push(`git.push ${branch}`);
          this.pushes.push(branch);
        },
      },
      readSkill: async () => this.skillText,
      ask: async ({ field, prompt }) => {
        this.prompts.push({ field, prompt });
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, this.askDelayMs);
        await promise;
        if (field === "Rewrite") {
          // The question's own examples name tickets too; the ticket asked about is the last one named.
          const ticket = [...prompt.matchAll(/Ticket ([A-Z][A-Z0-9]*-\d+)/g)].at(-1)![1]!;
          return JSON.stringify({ Rewrite: this.rewrite(this.issue(ticket)) });
        }
        return typeof this.repositoryReply === "string"
          ? this.repositoryReply
          : JSON.stringify({ Repository: this.repositoryReply });
      },
      implement: async ({ prompt }) => {
        this.events.push("implement");
        this.maybeFail("implement");
        this.implementPrompts.push(prompt);
        const next = this.implementations.shift();
        if (next === undefined) throw new Error("the fake code-improver has no scripted answer left");
        return `Done.\n${JSON.stringify(next)}`;
      },
      workWithoutCheckout: async ({ prompt }) => {
        this.events.push("work");
        this.workPrompts.push(prompt);
        const next = this.repolessWorks.shift();
        if (next === undefined) throw new Error("the fake ticket worker has no scripted answer left");
        return `Done.\n${JSON.stringify(next)}`;
      },
      review: async ({ prompt, verdictPath }) => {
        this.events.push(`review ${verdictPath.split("/").at(-1)}`);
        this.reviewPrompts.push(prompt);
        if (verdictPath.endsWith("root-cause.json")) return JSON.stringify(this.rootCause);
        const next = this.changeReviews.shift();
        if (next === undefined) throw new Error("the fake reviewer has no scripted change verdict left");
        return JSON.stringify(next);
      },
      makePrMergable: async (input) => {
        this.events.push("makePrMergable");
        this.mergeRuns.push(input);
        return this.mergeReport;
      },
      upgradeDependency: async ({ prUrl }) => {
        this.events.push("upgradeDependency");
        this.upgradeRuns.push(prUrl);
        return { ...this.upgradeReport };
      },
      fixRedCi: async ({ prUrl }) => {
        this.events.push("fixRedCi");
        this.fixRedCiRuns.push(prUrl);
        return { ...this.fixRedCiReport };
      },
      lock: {
        acquire: async ({ runId }) => {
          if (this.lockHolder !== undefined) {
            return { held: false, holder: { runId: this.lockHolder, ticket: this.lockHolderTicket } };
          }
          this.lockHolder = runId;
          this.held += 1;
          this.maxHeld = Math.max(this.maxHeld, this.held);
          return { held: true };
        },
        release: async (runId) => {
          if (this.lockHolder !== runId) return;
          this.lockHolder = undefined;
          this.held -= 1;
        },
      },
      checkpoints: {
        load: async (ticket) => {
          const found = this.checkpointStore.get(ticket);
          return found === undefined ? undefined : structuredClone(found);
        },
        save: async (checkpoint) => {
          this.checkpointSaves.push({ ticket: checkpoint.ticket, steps: [...checkpoint.steps], finished: checkpoint.finished });
          this.checkpointStore.set(checkpoint.ticket, structuredClone(checkpoint));
        },
        discard: async (ticket) => {
          this.checkpointStore.delete(ticket);
        },
        list: async () => [...this.checkpointStore.values()].map((checkpoint) => structuredClone(checkpoint)),
      },
      now: () => this.clockMs,
    };
  }
}
