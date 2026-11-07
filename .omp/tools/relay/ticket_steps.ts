import { ticketComment } from "./texts.js";
import type { Closing, Comment, Issue, Outcome, PullRequestRef, RelayPorts, Workspace, WorkspaceStatuses } from "./types.js";
import { isKnownOrg, TICKET_PATTERN, workspaceFor } from "./workspaces.js";

/**
 * How many times a write's read-back is re-read, and how long between reads. Linear answers a read from a lagging replica:
 * a live run saved a description and the next read still carried the old one, so one read is not proof. At a 1.25 s
 * interval a write that never lands still fails inside fifteen seconds.
 */
export const READ_BACK_ATTEMPTS = 12;
export const READ_BACK_INTERVAL_MS = 1_250;

/**
 * Re-reads until the write is visible (`visible` answers undefined) and throws its last reason when it never is. The one
 * owner of the policy: every read-back a Linear write needs goes through here.
 */
export async function readBack(ports: Pick<RelayPorts, "sleep">, visible: () => Promise<string | undefined>): Promise<void> {
  let reason = "no read-back was taken";
  for (let attempt = 1; attempt <= READ_BACK_ATTEMPTS; attempt++) {
    reason = (await visible()) ?? "";
    if (reason === "") return;
    if (attempt < READ_BACK_ATTEMPTS) await ports.sleep(READ_BACK_INTERVAL_MS);
  }
  throw new Error(reason);
}

/**
 * What a reader sees, as letters and digits. Linear normalises what it stores: it rewrites a link as `[label](<url>)`,
 * escapes characters, trims blanks, and expands a plain-text issue mention into the self-closing
 * `<issue id="<uuid>" label="ZYS-123" href="…"/>`, or keeps a reference the writer already tagged as
 * `<issue id="<uuid>" href="…">ZYS-123</issue>`. It also expands a bare `#342` that matches a workspace pull request into
 * `<pull-request id="<uuid>" href="…">org/repo#342</pull-request>`. A single-line `<tag …>label</tag>` keeps only its
 * label, a single-line `<tag … label="label" …/>` keeps that label attribute, `org/repo#123` is normalised to `#123`, and
 * markdown link targets are dropped.
 */
export function readerWords(text: string): string {
  return text
    .replace(/<([A-Za-z][\w-]*)((?:\s[^>\n]*?)?)\s*\/>/g, (_tag, _name: string, attrs: string) =>
      /(?:^|\s)label="([^"]*)"/.exec(attrs)?.[1] ?? "")
    .replace(/<([A-Za-z][\w-]*)(?:\s[^>\n]*)?>([^<\n]*?)<\/\1>/g, "$2")
    .replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)\b/g, "#$1")
    .replace(/\]\(\s*<[^>\n]*>\s*\)|\]\([^)\n]*\)/g, "]")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a stored body is the body that was written, by what a reader sees of each. */
export function sameWords(left: string, right: string): boolean {
  return readerWords(left) === readerWords(right);
}

const URL_PATTERN = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
/** The title tag the PR check writes on auto-created tickets: `[sah-pr:<org>/<repo>#<n>]`, whatever the organisation. */
const TAG_PATTERN = /\[sah-pr:([\w.-]+)\/([\w.-]+)#(\d+)\]/g;

/** Every pull request of a configured workspace organisation the texts name, by URL or by `sah-pr` tag, once each, in order first seen. */
export function linkedPullRequests(texts: readonly string[]): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  const add = (org: string, repo: string, number: string) => {
    if (!isKnownOrg(org)) return;
    const url = `https://github.com/${org}/${repo}/pull/${number}`;
    if (!found.has(url)) found.set(url, { url, org, repo, number: Number(number) });
  };
  for (const text of texts) {
    for (const match of text.matchAll(URL_PATTERN)) add(match[1]!, match[2]!, match[3]!);
    for (const match of text.matchAll(TAG_PATTERN)) add(match[1]!, match[2]!, match[3]!);
  }
  return [...found.values()];
}

export type LinearTicket = { workspace: Workspace; issue: Issue; comments: Comment[]; linkedPulls: PullRequestRef[] };

/**
 * REMOTE (Linear), read-only: the ticket from the workspace its identifier names, its comments, and the pull requests it
 * links through its attachments, title, description and comments.
 */
export async function getLinearTicket(ports: Pick<RelayPorts, "linear">, ticket: string): Promise<LinearTicket> {
  const workspace = workspaceFor(ticket);
  const [issue, comments] = await Promise.all([ports.linear.getIssue(workspace, ticket), ports.linear.listComments(workspace, ticket)]);
  const linkedPulls = linkedPullRequests([
    ...issue.attachments.map((attachment) => attachment.url),
    issue.title,
    issue.description,
    ...comments.map((comment) => comment.body),
  ]);
  return { workspace, issue, comments, linkedPulls };
}

/**
 * REMOTE (Linear): posts one comment on the ticket in its workspace, then lists the ticket's comments until one carries
 * the body (Linear's reads lag its writes) and throws when none ever does.
 */
export async function postTicketCommentAndReadBack(
  ports: Pick<RelayPorts, "linear" | "sleep">,
  input: { workspace: Workspace; ticket: string; body: string },
): Promise<void> {
  const { workspace, ticket } = input;
  await ports.linear.saveComment(workspace, { ticket, body: input.body });
  await readBack(ports, async () => {
    const comments = await ports.linear.listComments(workspace, ticket);
    return comments.some((comment) => sameWords(comment.body, input.body))
      ? undefined
      : `Linear write not visible on ${ticket}: no comment on it carries the body that was posted`;
  });
}

/**
 * REMOTE (Linear): sets the ticket's status by name (its id is looked up in the team's statuses; `duplicateOf` marks a
 * duplicate), then reads the issue back and throws unless the read-back shows the status.
 */
export async function writeStatusAndReadBack(
  ports: Pick<RelayPorts, "linear" | "sleep">,
  input: { workspace: Workspace; ticket: string; status: string; duplicateOf?: string },
): Promise<void> {
  const { linear } = ports;
  const { workspace, ticket } = input;
  const statuses = await linear.listStatuses(workspace);
  const found = statuses.find((status) => status.name === input.status);
  if (found === undefined) {
    throw new Error(`Linear has no status named "${input.status}" for ${ticket}; the team has: ${statuses.map((status) => status.name).join(", ")}`);
  }
  await linear.saveIssue(workspace, { ticket, stateId: found.id, duplicateOf: input.duplicateOf });
  await readBack(ports, async () => {
    const read = await linear.getIssue(workspace, ticket);
    return read.status === input.status
      ? undefined
      : `Linear write not visible on ${ticket}: asked for status "${input.status}", the read-back says "${read.status}"`;
  });
}

/** The ticket a superseded ticket points at, when `supersededBy` names one. */
function supersedingTicket(closing: Closing, ticket: string): string | undefined {
  const named = closing.supersededBy?.trim();
  return named !== undefined && TICKET_PATTERN.test(named) && named !== ticket ? named : undefined;
}

/** The Linear status each outcome leaves its ticket in, by the workspace's own names for them. */
export function statusOf(outcome: Outcome, superseding: string | undefined, statuses: WorkspaceStatuses): string {
  switch (outcome) {
    case "undecipherable":
    case "needs_info":
    case "blocked":
      return statuses.notReady;
    case "obsolete":
      return statuses.canceled;
    case "already_done":
    case "work_completed":
      return statuses.done;
    case "superseded":
      return superseding === undefined ? statuses.canceled : statuses.duplicate;
  }
}

/** Closing the linked pull requests is for an outcome that makes them pointless; `already_done` closes them only when the judge says they are redundant. */
function closesLinkedPullRequests(closing: Closing): boolean {
  switch (closing.outcome) {
    case "obsolete":
    case "superseded":
      return true;
    case "already_done":
      return closing.closeLinkedPullRequest;
    default:
      return false;
  }
}

export type Settlement = { status: string; closedPullRequests: string[] };

/**
 * REMOTE (GitHub, Linear): ends a ticket's run the way its outcome says. Linked open pull requests are closed first when the
 * outcome makes them pointless, each with the reason and read back as CLOSED; then the ticket gets its status (and
 * `duplicateOf` for a superseded one) and its comment, each read back. A failure leaves the ticket as it was, never settled
 * halfway silently.
 */
export async function settleTicketOutcome(
  ports: Pick<RelayPorts, "github" | "linear" | "sleep">,
  input: { workspace: Workspace; ticket: string; closing: Closing; linkedPulls: readonly PullRequestRef[] },
): Promise<Settlement> {
  const { closing, ticket, workspace } = input;
  const closedPullRequests: string[] = [];
  if (closesLinkedPullRequests(closing)) {
    for (const linked of input.linkedPulls) {
      const pull = await ports.github.readPullRequest(linked.url);
      if (pull.state !== "OPEN") continue;
      await ports.github.closePullRequest({
        url: pull.url,
        comment: `Closed by the relay for ${ticket} (${closing.outcome}): ${closing.summary}`,
      });
      const readBackPull = await ports.github.readPullRequest(pull.url);
      if (readBackPull.state !== "CLOSED") throw new Error(`${pull.url}: closing it was not visible; it is still ${readBackPull.state}`);
      closedPullRequests.push(pull.url);
    }
  }
  const superseding = closing.outcome === "superseded" ? supersedingTicket(closing, ticket) : undefined;
  const status = statusOf(closing.outcome, superseding, workspace.statuses);
  await writeStatusAndReadBack(ports, { workspace, ticket, status, duplicateOf: superseding });
  await postTicketCommentAndReadBack(ports, {
    workspace,
    ticket,
    body: ticketComment(closing, { closedPullRequests, supersededBy: superseding }),
  });
  return { status, closedPullRequests };
}

/** A pull request a run created or touched, by URL. */
export type TouchedPullRequest = { url: string };

/** The green-PR rule's answer: every touched pull request green, or the Closing that blocks the run. */
export type GreenPullRequests = { green: true; reports: readonly string[] } | { green: false; blocked: Closing };

/**
 * The one owner of the rule that every pull request a run touches goes through the red-CI pass before the run settles:
 * green PRs collect their reports, and the first red one answers the Closing that settles the run blocked, never done.
 */
export async function requireGreenPullRequests(
  ports: Pick<RelayPorts, "fixRedCi">,
  input: { pullRequests: readonly TouchedPullRequest[] },
): Promise<GreenPullRequests> {
  const reports: string[] = [];
  for (const pullRequest of input.pullRequests) {
    const { green, report } = await ports.fixRedCi({ prUrl: pullRequest.url });
    if (green) {
      reports.push(report);
      continue;
    }
    return {
      green: false,
      blocked: {
        outcome: "blocked",
        summary: `The red-CI pass could not green ${pullRequest.url}, so the pull request is still red.`,
        concerns: ["A green pull request — what the red-CI pass could not reach from this repository — would unblock this run."],
        evidence: [report],
        closeLinkedPullRequest: false,
      },
    };
  }
  return { green: true, reports };
}
