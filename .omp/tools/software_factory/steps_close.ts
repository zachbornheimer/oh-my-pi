import { landingLine, landPullRequest } from "./landing.js";
import type { FactoryPorts } from "./ports.js";
import { readBack } from "./read_back.js";
import {
  type Closing,
  type Issue,
  type Landing,
  type Outcome,
  type PublishedPullRequest,
  type PullRequestRef,
  TICKET_PATTERN,
} from "./schemas.js";
import { ticketComment } from "./texts.js";
import type { Workspace, WorkspaceStatuses } from "./workspaces.js";

// ── Linear writes, each read back ───────────────────────────────────────────────────────────────────────────────

/**
 * What a reader sees, as letters and digits. Linear normalises what it stores: it rewrites a link as `[label](<url>)`, escapes
 * characters, trims blanks, and expands a plain-text issue mention into the self-closing
 * `<issue id="<uuid>" label="ZYS-123" href="…"/>`, or keeps a reference the writer already tagged as
 * `<issue id="<uuid>" href="…">ZYS-123</issue>`. It also expands a bare `#342` that matches a workspace pull request into
 * `<pull-request id="<uuid>" href="…">org/repo#342</pull-request>`. A single-line `<tag …>label</tag>` keeps only its label
 * (requiring whitespace or `>` after the tag name so placeholders like `<issue|pr>` are never read as opening `<issue>`
 * tags), a single-line `<tag … label="label" …/>` keeps that label attribute — the mention chip a reader sees —
 * `org/repo#123` is normalised to `#123` so a pull-request auto-link matches the `#123` that was written, and markdown link
 * targets are dropped without a multiline `<[^>]*>` sweep that would eat between a `<` in code and a later `>`.
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

/**
 * Where two bodies first stop agreeing by what a reader sees of each, or "" when they agree: the letters and digits
 * around the first difference, few enough for a run record to carry. `readerWords` has already stripped Linear's own
 * normalisation, so a difference this reports is a real one.
 */
export function readerDifference(read: string, written: string): string {
  const seen = readerWords(read);
  const wrote = readerWords(written);
  let at = 0;
  while (at < seen.length && at < wrote.length && seen[at] === wrote[at]) at++;
  if (at === seen.length && at === wrote.length) return "";
  const around = (text: string) =>
    `${at > 24 ? "…" : ""}${text.slice(Math.max(0, at - 24), at + 40)}${at + 40 < text.length ? "…" : ""}`;
  return `; ${wrote.length} characters were saved and ${seen.length} read back, first differing at ${at}: wrote "${around(wrote)}", read "${around(seen)}"`;
}

export type TicketWrite = {
  workspace: Workspace;
  ticket: string;
  description?: string;
  /** A status name; its id is looked up in the team's statuses. */
  status?: string;
  /** The ticket this one duplicates; only with status `Duplicate`. */
  duplicateOf?: string;
};

/**
 * REMOTE (Linear): writes the ticket's description and/or status in one `save_issue`, then reads the issue back
 * and throws unless the read-back shows each write. Answers the issue as read back.
 */
export async function writeTicketAndReadBack(
  ports: Pick<FactoryPorts, "linear" | "sleep">,
  input: TicketWrite,
): Promise<Issue> {
  const { linear } = ports;
  const { workspace } = input;
  let stateId: string | undefined;
  if (input.status !== undefined) {
    const statuses = await linear.listStatuses(workspace);
    const found = statuses.find((status) => status.name === input.status);
    if (found === undefined) {
      throw new Error(
        `Linear has no status named "${input.status}" for ${input.ticket}; the team has: ${statuses.map((status) => status.name).join(", ")}`,
      );
    }
    stateId = found.id;
  }
  await linear.saveIssue(workspace, {
    ticket: input.ticket,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(input.duplicateOf === undefined ? {} : { duplicateOf: input.duplicateOf }),
  });
  let read: Issue | undefined;
  await readBack(ports, async () => {
    read = await linear.getIssue(workspace, input.ticket);
    if (input.status !== undefined && read.status !== input.status) {
      return `Linear write not visible on ${input.ticket}: asked for status "${input.status}", the read-back says "${read.status}"`;
    }
    if (input.description !== undefined && !sameWords(read.description, input.description)) {
      return `Linear write not visible on ${input.ticket}: the read-back description is not the one that was saved${readerDifference(read.description, input.description)}`;
    }
    return undefined;
  });
  if (read === undefined) throw new Error(`Linear read no issue for ${input.ticket}`);
  return read;
}

/**
 * REMOTE (Linear): posts one comment on the ticket in its workspace, then lists the ticket's comments until one carries
 * the body (Linear's reads lag its writes) and throws when none ever does. Answers nothing: the comment is the effect.
 */
export async function postTicketCommentAndReadBack(
  ports: Pick<FactoryPorts, "linear" | "sleep">,
  input: { workspace: Workspace; ticket: string; body: string },
): Promise<void> {
  const { workspace, ticket } = input;
  await ports.linear.saveComment(workspace, { ticket, body: input.body });
  await readBack(ports, async () => {
    const comments = await ports.linear.listComments(workspace, ticket);
    return comments.some((comment) => sameWords(comment.body, input.body))
      ? undefined
      : `Linear write not visible on ${input.ticket}: no comment on it carries the body that was posted`;
  });
}

// ── settle_ticket_outcome ───────────────────────────────────────────────────────────────────────────────────────

/** The ticket a superseded ticket points at, when `supersededBy` names one. */
function supersedingTicket(closing: Closing, ticket: string): string | undefined {
  const named = closing.supersededBy?.trim();
  return named !== undefined && TICKET_PATTERN.test(named) && named !== ticket ? named : undefined;
}

/** The Linear status each outcome leaves its ticket in, by the workspace's own names for them. */
export function statusOf(
  outcome: Exclude<Outcome, "busy">,
  superseding: string | undefined,
  statuses: WorkspaceStatuses,
): string {
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
    case "pr_ready":
      return statuses.pullRequest;
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
 * REMOTE (GitHub, Linear): ends a ticket's run the way its outcome says. Linked open pull requests are closed first when
 * the outcome makes them pointless, each with the reason and read back as CLOSED; then the ticket gets its status (and
 * `duplicateOf` for a superseded one) and its comment, each read back. A failure leaves the ticket as it was, never settled
 * halfway silently.
 */
export async function settleTicketOutcome(
  ports: Pick<FactoryPorts, "github" | "linear" | "sleep">,
  input: {
    workspace: Workspace;
    ticket: string;
    closing: Closing;
    linkedPulls: readonly PullRequestRef[];
    pullRequest?: PublishedPullRequest;
  },
): Promise<Settlement> {
  const { closing, ticket, workspace } = input;
  if (closing.outcome === "busy") throw new Error(`${ticket}: a busy run settles nothing`);
  const closedPullRequests: string[] = [];
  if (closesLinkedPullRequests(closing)) {
    for (const linked of input.linkedPulls) {
      const pull = await ports.github.readPullRequest(linked.url);
      if (pull.state !== "OPEN") continue;
      await ports.github.closePullRequest({
        url: pull.url,
        comment: `Closed by the software factory for ${ticket} (${closing.outcome}): ${closing.summary}`,
      });
      const readBackPull = await ports.github.readPullRequest(pull.url);
      if (readBackPull.state !== "CLOSED") throw new Error(`${pull.url}: closing it was not visible; it is still ${readBackPull.state}`);
      closedPullRequests.push(pull.url);
    }
  }
  const superseding = closing.outcome === "superseded" ? supersedingTicket(closing, ticket) : undefined;
  const status = statusOf(closing.outcome, superseding, workspace.statuses);
  await writeTicketAndReadBack(ports, { workspace, ticket, status, ...(superseding === undefined ? {} : { duplicateOf: superseding }) });
  await postTicketCommentAndReadBack(ports, {
    workspace,
    ticket,
    body: ticketComment(closing, {
      ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
      closedPullRequests,
      ...(superseding === undefined ? {} : { supersededBy: superseding }),
    }),
  });
  return { status, closedPullRequests };
}

// ── require_green_pull_requests ─────────────────────────────────────────────────────────────────────────────────

/** A pull request a run created or touched, by URL; `draft` marks one CI will not run on. */
export type TouchedPullRequest = { url: string; draft?: boolean };

/** The green-PR rule's answer: every touched pull request green, or the Closing that blocks the run. */
export type GreenPullRequests =
  | { green: true; reports: readonly string[] }
  | { green: false; blocked: Closing };

/**
 * The one owner of the rule that every pull request a run touches goes through fix_red_ci before the run settles: green
 * PRs collect their reports, a red draft collects its report (a remand's draft is red by design — blocking would loop the
 * remand forever), and the first red non-draft answers the Closing that settles the run blocked, never done.
 */
export async function requireGreenPullRequests(
  ports: Pick<FactoryPorts, "fixRedCi">,
  input: { pullRequests: readonly TouchedPullRequest[] },
): Promise<GreenPullRequests> {
  const reports: string[] = [];
  for (const pullRequest of input.pullRequests) {
    const { green, report } = await ports.fixRedCi({ prUrl: pullRequest.url });
    if (green || pullRequest.draft) {
      reports.push(report);
      continue;
    }
    return {
      green: false,
      blocked: {
        outcome: "blocked",
        summary: `fix_red_ci could not green ${pullRequest.url}, so the pull request is still red.`,
        concerns: ["A green pull request — what fix_red_ci could not reach from this repository — would unblock this run."],
        evidence: [report],
        closeLinkedPullRequest: false,
      },
    };
  }
  return { green: true, reports };
}

// ── land_ticket_pull_request ────────────────────────────────────────────────────────────────────────────────────

/** The ticket comment that carries a landing: the route and state, the capability's reasons, and whether the pull request landed. */
export function landingComment(landing: Landing): string {
  return [
    `**Software factory: ${landing.route} on ${landing.url}: ${landing.state}**`,
    ...(landing.reasons.length === 0 ? [] : ["", ...landing.reasons.map((reason) => `- ${reason}`)]),
    "",
    landingLine(landing),
  ].join("\n");
}

/**
 * REMOTE (GitHub via upgrade_dependency or make_pr_mergable; Linear): lands the ticket's pull request when `merge` is
 * true — a dependency bot's through upgrade_dependency, any other through make_pr_mergable with merge — and otherwise only
 * drives it to settled approved. The landing is posted to the ticket (read back) and answered; the ticket's status stays
 * `Pull Request`, because a pull request that has not landed is not a done ticket.
 */
export async function landTicketPullRequest(
  ports: Pick<FactoryPorts, "github" | "makePrMergable" | "upgradeDependency" | "linear" | "sleep">,
  input: { workspace: Workspace; ticket: string; prUrl: string; merge: boolean },
): Promise<Landing> {
  const landing = await landPullRequest(
    {
      readPullRequestAuthor: (url) => ports.github.readPullRequestAuthor(url),
      makePrMergable: ports.makePrMergable,
      upgradeDependency: ports.upgradeDependency,
    },
    input.prUrl,
    { merge: input.merge },
  );
  await postTicketCommentAndReadBack(ports, { workspace: input.workspace, ticket: input.ticket, body: landingComment(landing) });
  return landing;
}
