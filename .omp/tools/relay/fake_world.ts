import type {
  Comment,
  Improvement,
  Issue,
  LinearStatus,
  PullRequest,
  RelayPorts,
  RewriteAnswer,
  RootCauseVerdict,
  WorkRecord,
  Workspace,
} from "./types.js";

export const ORG = "Software-Automation-Holdings-LLC";
export const PERSONAL_ORG = "zachbornheimer";

export const pullUrl = (org: string, repo: string, number: number): string => `https://github.com/${org}/${repo}/pull/${number}`;

export const worked = (overrides: Partial<WorkRecord> = {}): WorkRecord => ({
  outcome: "work_completed",
  summary: "The deliverable is on the ticket.",
  used: { tools: ["tickets"], skills: [], workflows: [] },
  concerns: [],
  evidence: ["the answer, recorded on the ticket"],
  closeLinkedPullRequest: false,
  pullRequests: [],
  ...overrides,
});

export const nothingMissing = (summary = "The existing capabilities, tools and skills were enough."): Improvement => ({
  improvement: "none",
  summary,
  evidence: [],
  pullRequests: [],
});

export const realVerdict = (overrides: Partial<RootCauseVerdict> = {}): RootCauseVerdict => ({
  verdict: "real",
  workInThisCheckout: false,
  rootCause: "The host's cron never runs the sweep.",
  summary: "Real work, and it lives on the host.",
  evidence: ["the host's crontab"],
  concerns: [],
  closeLinkedPullRequest: false,
  ...overrides,
});

/**
 * The relay's world in memory: a Linear with tickets, comments and statuses, a GitHub with pull requests, and scripted
 * model answers. A test scripts the answers and then reads what the run did. Nothing here touches the network, a
 * repository or a process.
 */
export class FakeRelay {
  readonly issues = new Map<string, Issue>();
  readonly commentsByTicket = new Map<string, Comment[]>();
  readonly pulls = new Map<string, PullRequest>();
  /** Every effect, in order, so a test can assert what ran before what. */
  readonly events: string[] = [];
  readonly linearWrites: string[] = [];
  readonly closed: string[] = [];
  readonly duplicates: { ticket: string; of: string }[] = [];
  readonly askPrompts: { field: string; prompt: string }[] = [];
  readonly reviewPrompts: string[] = [];
  readonly workPrompts: string[] = [];
  readonly improvePrompts: string[] = [];
  readonly fixRedCiRuns: string[] = [];
  readonly skills = new Map<string, string>([["tickets", "THE TICKETS SKILL"]]);

  works: WorkRecord[] = [];
  improvements: Improvement[] = [];
  rewrite: (issue: Issue) => RewriteAnswer = (issue) => ({ decipherable: true, description: `## Outcome\n${issue.title}`, questions: [] });
  rootCause: RootCauseVerdict = realVerdict();
  fixRedCiReport: { green: boolean; report: string } = { green: true, report: "The pull request has no failed check." };
  /** When set, this many reads of a ticket still show it as it was before the last write (Linear's lagging replica). */
  lag = 0;
  private lagging = new Map<string, Issue>();
  /** Makes the next `saveComment` silently drop the comment, so the read-back can never see it. */
  dropComments = false;
  sleeps: number[] = [];
  private nextId = 1;

  addIssue(ticket: string, overrides: Partial<Issue> = {}): Issue {
    const issue: Issue = {
      identifier: ticket,
      title: `Ticket ${ticket}`,
      description: "The cron sweep is broken.",
      status: "Triage",
      priority: 2,
      createdAt: "2026-11-01T00:00:00Z",
      url: `https://linear.app/x/issue/${ticket}`,
      gitBranchName: ticket.toLowerCase(),
      attachments: [],
      ...overrides,
    };
    this.issues.set(ticket, issue);
    this.commentsByTicket.set(ticket, []);
    return issue;
  }

  issue(ticket: string): Issue {
    const found = this.issues.get(ticket);
    if (found === undefined) throw new Error(`no fake issue ${ticket}`);
    return found;
  }

  commentsOn(ticket: string): string[] {
    return (this.commentsByTicket.get(ticket) ?? []).map((comment) => comment.body);
  }

  addPull(url: string, overrides: Partial<PullRequest> = {}): PullRequest {
    const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)!;
    const pull: PullRequest = {
      url,
      org: match[1]!,
      repo: match[2]!,
      number: Number(match[3]),
      state: "OPEN",
      isDraft: false,
      headRef: "feature",
      baseRef: "main",
      ...overrides,
    };
    this.pulls.set(url, pull);
    return pull;
  }

  ports(): RelayPorts {
    const statusesOf = (workspace: Workspace): LinearStatus[] => Object.values(workspace.statuses).map((name) => ({ id: `id:${name}`, name }));
    return {
      linear: {
        getIssue: async (_workspace, ticket) => {
          this.events.push(`linear.getIssue ${ticket}`);
          const stale = this.lagging.get(ticket);
          if (stale !== undefined && this.lag > 0) {
            this.lag -= 1;
            return stale;
          }
          return this.issue(ticket);
        },
        listComments: async (_workspace, ticket) => {
          this.events.push(`linear.listComments ${ticket}`);
          return [...(this.commentsByTicket.get(ticket) ?? [])];
        },
        listStatuses: async (workspace) => statusesOf(workspace),
        saveIssue: async (workspace, input) => {
          this.events.push(`linear.saveIssue ${input.ticket}`);
          this.linearWrites.push(`linear.saveIssue ${input.ticket}`);
          const status = statusesOf(workspace).find((candidate) => candidate.id === input.stateId);
          const before = this.issue(input.ticket);
          if (this.lag > 0) this.lagging.set(input.ticket, before);
          if (status !== undefined) this.issues.set(input.ticket, { ...before, status: status.name });
          if (input.duplicateOf !== undefined) this.duplicates.push({ ticket: input.ticket, of: input.duplicateOf });
        },
        saveComment: async (_workspace, input) => {
          this.events.push(`linear.saveComment ${input.ticket}`);
          this.linearWrites.push(`linear.saveComment ${input.ticket}`);
          if (this.dropComments) return;
          // Linear stores what it normalises: a mention becomes a tag, which the read-back must see through.
          const stored = input.body.replace(/\b([A-Z]{2,5}-\d+)\b/g, '<issue id="u" label="$1" href="h"/>');
          this.commentsByTicket.get(input.ticket)?.push({ id: `c${this.nextId++}`, body: stored, createdAt: new Date(2026, 10, 1, 0, 0, this.nextId).toISOString() });
        },
      },
      github: {
        readPullRequest: async (url) => {
          const pull = this.pulls.get(url);
          if (pull === undefined) throw new Error(`no fake pull request ${url}`);
          return pull;
        },
        closePullRequest: async ({ url, comment }) => {
          this.events.push(`github.close ${url}`);
          this.closed.push(`${url}: ${comment}`);
          const pull = this.pulls.get(url);
          if (pull !== undefined) this.pulls.set(url, { ...pull, state: "CLOSED" });
        },
      },
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      readSkill: async (name) => {
        const skill = this.skills.get(name);
        if (skill === undefined) throw new Error(`no fake skill ${name}`);
        return skill;
      },
      ask: async ({ field, prompt }) => {
        this.events.push(`ask ${field}`);
        this.askPrompts.push({ field, prompt });
        const material = prompt.split("\nPrompt:\n").at(-1) ?? "";
        const ticket = /Ticket ([A-Z]+-\d+)/.exec(material)?.[1] ?? "";
        const answer = this.rewrite(this.issue(ticket));
        return `Here you go.\n${JSON.stringify({ Rewrite: answer })}`;
      },
      review: async ({ prompt, verdictPath }) => {
        this.events.push(`review ${verdictPath.split("/").at(-1)}`);
        this.reviewPrompts.push(prompt);
        return JSON.stringify(this.rootCause);
      },
      fixRedCi: async ({ prUrl }) => {
        this.events.push("fixRedCi");
        this.fixRedCiRuns.push(prUrl);
        return this.fixRedCiReport;
      },
      work: async ({ prompt }) => {
        this.events.push("relay-work");
        this.workPrompts.push(prompt);
        const next = this.works.shift();
        if (next === undefined) throw new Error("the fake relay worker has no scripted answer left");
        return `Done.\n${JSON.stringify(next)}`;
      },
      improve: async ({ prompt }) => {
        this.events.push("relay-improve");
        this.improvePrompts.push(prompt);
        const next = this.improvements.shift();
        if (next === undefined) throw new Error("the fake relay improver has no scripted answer left");
        return `Done.\n${JSON.stringify(next)}`;
      },
    };
  }
}
