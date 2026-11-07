import type { GhsecSource } from "./constants.js";
import type { Workspace } from "./workspaces.js";

export type RepositoryListing = { name: string; isArchived: boolean; isFork: boolean };

/**
 * A repository this account cannot read one source's alerts for: the feature is not enabled, or there is no access, or
 * the repository is empty. Not a failure — the repository counts as skipped and the run continues.
 */
export class AlertsUnavailableError extends Error {
  constructor(
    readonly repository: string,
    readonly reason: string,
  ) {
    super(`${repository}: ${reason}`);
    this.name = "AlertsUnavailableError";
  }
}

/** The alert is gone from GitHub: deleted, or the repository no longer carries it. */
export class AlertGoneError extends Error {
  constructor(readonly repository: string) {
    super(`${repository}: the alert is gone from GitHub`);
    this.name = "AlertGoneError";
  }
}

/** GitHub's security alerts, through `gh`. */
export type SecurityGhPort = {
  /** Every repository of the owner, archived ones included: the run skips those itself. */
  listRepos(owner: string): Promise<RepositoryListing[]>;
  /** One source's open alerts of one repository, raw as GitHub answers them, pagination walked to the end. */
  listAlerts(input: { source: GhsecSource; owner: string; repo: string }): Promise<unknown[]>;
  /** One alert as GitHub answers it today. */
  readAlert(input: { source: GhsecSource; owner: string; repo: string; number: number }): Promise<unknown>;
};

/** The Linear workspace of the run. */
export type SecurityLinearPort = {
  /** Every issue of the workspace's team whose title carries `text`, with title and status. */
  searchIssues(workspace: Workspace, text: string): Promise<{ identifier: string; title: string; status: string }[]>;
  listStatuses(workspace: Workspace): Promise<{ id: string; name: string }[]>;
  /** The label of this name the team can use (a workspace label or the team's own), or undefined; none is ever created. */
  findLabel(workspace: Workspace, name: string): Promise<{ id: string; name: string } | undefined>;
  getIssue(workspace: Workspace, ticket: string): Promise<{ identifier: string; title: string; description: string; status: string }>;
  /** Creates one issue and answers its identifier. */
  createIssue(
    workspace: Workspace,
    input: { title: string; description: string; priority: number; stateId: string; labelIds?: readonly string[] },
  ): Promise<{ identifier: string }>;
  saveIssueState(workspace: Workspace, input: { ticket: string; stateId: string }): Promise<void>;
  saveComment(workspace: Workspace, input: { ticket: string; body: string }): Promise<void>;
  listComments(workspace: Workspace, ticket: string): Promise<{ body: string }[]>;
};

/** Every effect the run takes; tests substitute all of it. */
export type SecurityPorts = {
  gh: SecurityGhPort;
  linear: SecurityLinearPort;
  /** Waits between a write's read-back attempts: Linear's reads lag its writes. Rejects when the call is cancelled. */
  sleep(ms: number): Promise<void>;
  /** The date the settle comment carries. */
  today(): string;
  /** Throws when the tool call was cancelled; per-ticket loops call it so a cancel is never recorded as a ticket failure. */
  throwIfCancelled(): void;
  /** One progress line for the tool call's heartbeat. */
  progress(message: string): void;
};
