import type { GhsecSource } from "./constants.js";
import {
  AlertGoneError,
  AlertsUnavailableError,
  type RepositoryListing,
  type SecurityGhPort,
  type SecurityLinearPort,
  type SecurityPorts,
} from "./ports.js";
import type { Workspace } from "./workspaces.js";

export type FakeAlert = { source: GhsecSource; owner: string; repo: string; raw: Record<string, unknown> };

/** An in-memory GitHub and Linear. Every call is recorded; nothing leaves the process. */
export class FakeSecurityWorld {
  repos = new Map<string, RepositoryListing[]>();
  /** Alerts by `owner/repo:source:number`. */
  alerts = new Map<string, FakeAlert>();
  /** `owner/repo:source` whose listing answers 403. */
  forbidden = new Set<string>();
  /** `owner/repo:source:number` whose single read answers 404. */
  missing = new Set<string>();
  /** Listing failures that are not 403/404. */
  broken = new Map<string, string>();
  statuses: { id: string; name: string }[] = [
    { id: "s-triage", name: "Triage" },
    { id: "s-unreviewed", name: "Unreviewed" },
    { id: "s-done", name: "Done" },
  ];
  labels: { id: string; name: string }[] = [];
  issues = new Map<string, { identifier: string; title: string; description: string; status: string; priority: number; labelIds: string[]; comments: string[] }>();
  /** Reads of an issue that answer the pre-write state this many times (Linear's lagging replica). */
  lag = 0;
  private lagLeft = new Map<string, { status: string }>();
  nextIssue = 100;
  calls: string[] = [];
  /** Created tickets whose read-back never shows the status. */
  neverLands = false;
  failCreateFor?: string;
  failCommentFor?: string;

  setAlert(owner: string, repo: string, source: GhsecSource, number: number, raw: Record<string, unknown> = {}): void {
    this.alerts.set(`${owner}/${repo}:${source}:${number}`, {
      source,
      owner,
      repo,
      raw: { number, state: "open", html_url: `https://github.com/${owner}/${repo}/security/${source}/${number}`, ...raw },
    });
  }

  closeAlert(owner: string, repo: string, source: GhsecSource, number: number, patch: Record<string, unknown>): void {
    const alert = this.alerts.get(`${owner}/${repo}:${source}:${number}`)!;
    alert.raw = { ...alert.raw, ...patch };
  }

  addTicket(identifier: string, title: string, status = "Triage"): void {
    this.issues.set(identifier, { identifier, title, description: "", status, priority: 3, labelIds: [], comments: [] });
  }

  gh: SecurityGhPort = {
    listRepos: async (owner) => {
      this.calls.push(`gh:listRepos:${owner}`);
      return this.repos.get(owner) ?? [];
    },
    listAlerts: async ({ source, owner, repo }) => {
      this.calls.push(`gh:listAlerts:${owner}/${repo}:${source}`);
      const key = `${owner}/${repo}:${source}`;
      if (this.forbidden.has(key)) throw new AlertsUnavailableError(`${owner}/${repo}`, "HTTP 403: not enabled");
      const broken = this.broken.get(key);
      if (broken !== undefined) throw new Error(broken);
      return [...this.alerts.values()]
        .filter((alert) => alert.owner === owner && alert.repo === repo && alert.source === source && alert.raw.state === "open")
        .map((alert) => alert.raw);
    },
    readAlert: async ({ source, owner, repo, number }) => {
      this.calls.push(`gh:readAlert:${owner}/${repo}:${source}:${number}`);
      const key = `${owner}/${repo}:${source}:${number}`;
      if (this.missing.has(key) || !this.alerts.has(key)) throw new AlertGoneError(`${owner}/${repo}`);
      return this.alerts.get(key)!.raw;
    },
  };

  linear: SecurityLinearPort = {
    searchIssues: async (_workspace, text) => {
      this.calls.push(`linear:search:${text}`);
      return [...this.issues.values()].filter((issue) => issue.title.includes(text)).map(({ identifier, title, status }) => ({ identifier, title, status }));
    },
    listStatuses: async () => this.statuses,
    findLabel: async (_workspace, name) => this.labels.find((label) => label.name === name),
    getIssue: async (_workspace, ticket) => {
      const issue = this.issues.get(ticket);
      if (issue === undefined) throw new Error(`no issue ${ticket}`);
      if (this.neverLands) return { ...issue, status: "Unreviewed-not-yet" };
      return { identifier: issue.identifier, title: issue.title, description: issue.description, status: issue.status };
    },
    createIssue: async (workspace, input) => {
      this.calls.push("linear:create");
      if (this.failCreateFor !== undefined && input.title.includes(this.failCreateFor)) throw new Error("Linear issueCreate answered HTTP 500");
      const identifier = `${workspace.team}-${this.nextIssue++}`;
      const status = this.statuses.find((entry) => entry.id === input.stateId)!.name;
      this.issues.set(identifier, {
        identifier,
        title: input.title,
        description: input.description,
        status,
        priority: input.priority,
        labelIds: [...(input.labelIds ?? [])],
        comments: [],
      });
      return { identifier };
    },
    saveIssueState: async (_workspace, { ticket, stateId }) => {
      this.calls.push(`linear:state:${ticket}`);
      const issue = this.issues.get(ticket)!;
      const next = this.statuses.find((entry) => entry.id === stateId)!.name;
      if (this.lag > 0) this.lagLeft.set(ticket, { status: issue.status });
      issue.status = next;
    },
    saveComment: async (_workspace, { ticket, body }) => {
      this.calls.push(`linear:comment:${ticket}`);
      if (this.failCommentFor === ticket) throw new Error("Linear save_comment was refused (success: false)");
      this.issues.get(ticket)!.comments.push(body);
    },
    listComments: async (_workspace, ticket) => this.issues.get(ticket)!.comments.map((body) => ({ body })),
  };

  sleeps: number[] = [];
  cancelled = false;
  progressLines: string[] = [];

  ports(): SecurityPorts {
    return {
      gh: this.gh,
      linear: this.lagging(),
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      today: () => "2026-11-06",
      throwIfCancelled: () => {
        if (this.cancelled) throw new Error("cancelled by user");
      },
      progress: (message) => {
        this.progressLines.push(message);
      },
    };
  }

  /** Wraps `getIssue` so the first `lag` reads after a state write still answer the old status. */
  private lagging(): SecurityLinearPort {
    const base = this.linear;
    let stale = 0;
    return {
      ...base,
      saveIssueState: async (workspace: Workspace, input) => {
        const before = this.issues.get(input.ticket)!.status;
        await base.saveIssueState(workspace, input);
        if (this.lag > 0) {
          stale = this.lag;
          this.lagLeft.set(input.ticket, { status: before });
        }
      },
      getIssue: async (workspace, ticket) => {
        const real = await base.getIssue(workspace, ticket);
        const old = this.lagLeft.get(ticket);
        if (old !== undefined && stale > 0) {
          stale -= 1;
          if (stale === 0) this.lagLeft.delete(ticket);
          return { ...real, status: old.status };
        }
        return real;
      },
    };
  }
}
