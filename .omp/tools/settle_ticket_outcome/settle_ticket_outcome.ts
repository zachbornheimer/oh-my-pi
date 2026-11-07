import { assertKnownOrg, type Workspace, type WorkspaceStatuses, workspaceFor } from "./workspaces.js";
import { type GitHubPort, parsePullUrl } from "./github.js";
import type { LinearPort } from "./linear.js";
import { readerWords, sameWords } from "./reader_words.js";
import { isObj, LINEAR_ID, oneOf, reqBool, reqObject, reqString, ticketId } from "./shape.js";
import { type Closing, OUTCOMES, type Outcome, type PublishedPullRequest, ticketComment } from "./texts.js";

export const SETTLE_TICKET_OUTCOME_NAME = "settle_ticket_outcome";

/** Linear answers a read from a lagging replica: a write is called invisible only after this many looks, this far apart. */
export const READ_BACK_ATTEMPTS = 3;
export const READ_BACK_INTERVAL_MS = 5_000;

export interface Settlement {
  status: string;
  closedPullRequests: string[];
}

export interface SettleDeps {
  github: GitHubPort;
  linear: LinearPort;
  sleep(ms: number): Promise<void>;
}

/** The closing a caller passes, checked. */
export function closingOf(value: unknown): Closing {
  const object = reqObject(value, "closing");
  const strings = (key: string): string[] => {
    const items = object[key];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error(`closing.${key} must be an array of strings`);
    return items as string[];
  };
  const outcome = oneOf(object, "outcome", OUTCOMES);
  if (typeof object.summary !== "string") throw new Error("closing.summary must be a string");
  const supersededBy = object.supersededBy;
  if (supersededBy !== undefined && supersededBy !== null && typeof supersededBy !== "string") throw new Error("closing.supersededBy must be a string");
  return {
    outcome,
    summary: object.summary,
    concerns: strings("concerns"),
    evidence: strings("evidence"),
    ...(typeof supersededBy === "string" ? { supersededBy } : {}),
    closeLinkedPullRequest: reqBool(object, "closeLinkedPullRequest"),
  };
}

/**
 * The pull requests linked to the ticket, as canonical URLs, each once. A caller may pass URLs or `{url, ...}` references
 * (the Mastra twin's shape); only the URL is read, and the owner, repository and number come from it.
 */
export function linkedPullsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("linkedPulls must be an array");
  const urls = value.map((entry, index) => {
    const url = typeof entry === "string" ? entry : isObj(entry) ? reqString(entry, "url") : undefined;
    if (url === undefined) throw new Error(`linkedPulls[${index}] must be a pull request URL or an object with one`);
    return parsePullUrl(url).url;
  });
  return [...new Set(urls)];
}

export function pullRequestOf(value: unknown): PublishedPullRequest | undefined {
  if (value === undefined || value === null) return undefined;
  const object = reqObject(value, "pullRequest");
  const number = object.number;
  if (typeof number !== "number" || !Number.isInteger(number)) throw new Error("pullRequest.number must be an integer");
  return { url: reqString(object, "url"), number, draft: reqBool(object, "draft") };
}

/** The ticket a superseded ticket points at, when `supersededBy` names one. */
export function supersedingTicket(closing: Closing, ticket: string): string | undefined {
  const named = closing.supersededBy?.trim().toUpperCase();
  return named !== undefined && LINEAR_ID.test(named) && named !== ticket ? named : undefined;
}

/** The Linear status each outcome leaves its ticket in, by the workspace's own names for them. */
export function statusOf(outcome: Exclude<Outcome, "busy">, superseding: string | undefined, statuses: WorkspaceStatuses): string {
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
export function closesLinkedPullRequests(closing: Closing): boolean {
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

/** Looks until the write is visible (`visible` answers undefined) and throws its last reason when it never is. */
async function readBack(deps: Pick<SettleDeps, "sleep">, visible: () => Promise<string | undefined>): Promise<void> {
  let reason = "no read-back was taken";
  for (let attempt = 1; attempt <= READ_BACK_ATTEMPTS; attempt++) {
    reason = (await visible()) ?? "";
    if (reason === "") return;
    if (attempt < READ_BACK_ATTEMPTS) await deps.sleep(READ_BACK_INTERVAL_MS);
  }
  throw new Error(reason);
}

/**
 * REMOTE (GitHub, Linear): ends a ticket's run the way its outcome says. Linked open pull requests are closed first when
 * the outcome makes them pointless, each with the reason and read back as CLOSED; then the ticket gets its status (and a
 * duplicate relation for a superseded one) and its comment, and a separate read-only look at the ticket must show both.
 * Every linked pull request is checked (a real URL, an organisation the factory owns) before anything is closed, so a bad
 * one refuses the whole call with nothing written. A failure after that point is not undone: closed pull requests stay closed.
 */
export async function settleTicketOutcome(
  input: { ticket: string; closing: unknown; linkedPulls: unknown; pullRequest?: unknown },
  deps: SettleDeps,
): Promise<Settlement> {
  const ticket = ticketId(input.ticket);
  const closing = closingOf(input.closing);
  const linked = linkedPullsOf(input.linkedPulls);
  const pullRequest = pullRequestOf(input.pullRequest);
  if (closing.outcome === "busy") throw new Error(`${ticket}: a busy run settles nothing`);
  const workspace: Workspace = workspaceFor(ticket);

  const toClose = closesLinkedPullRequests(closing) ? linked : [];
  for (const url of toClose) assertKnownOrg(parsePullUrl(url).org);

  const closedPullRequests: string[] = [];
  for (const url of toClose) {
    const pull = await deps.github.readPullRequest(url);
    if (pull.state !== "OPEN") continue;
    await deps.github.closePullRequest({
      url: pull.url,
      comment: `Closed by the software factory for ${ticket} (${closing.outcome}): ${closing.summary}`,
    });
    const readBackPull = await deps.github.readPullRequest(pull.url);
    if (readBackPull.state !== "CLOSED") {
      throw new Error(`${pull.url}: closing it was not visible; it is still ${readBackPull.state}`);
    }
    closedPullRequests.push(pull.url);
  }

  const superseding = closing.outcome === "superseded" ? supersedingTicket(closing, ticket) : undefined;
  const status = statusOf(closing.outcome, superseding, workspace.statuses);
  const comment = ticketComment(closing, { pullRequest, closedPullRequests, supersededBy: superseding });
  await deps.linear.write(workspace, { ticket, status, ...(superseding === undefined ? {} : { duplicateOf: superseding }), comment });
  await readBack(deps, async () => {
    const seen = await deps.linear.read(workspace, ticket);
    if (seen.status !== status) {
      return `Linear write not visible on ${ticket}: asked for status "${status}", the read-back says "${seen.status}"`;
    }
    if (readerWords(comment) === "" || !seen.comments.some((body) => sameWords(body, comment))) {
      return `Linear write not visible on ${ticket}: no comment on it carries the body that was posted`;
    }
    return undefined;
  });
  return { status, closedPullRequests };
}
