import {
  bySeverityDescending,
  findGhsecTag,
  type GhsecSource,
  ghsecTag,
  parseGhsecTag,
  SECURITY_LABEL,
  SEVERITY_PRIORITY,
  severityRank,
  SWEEP_SOURCES,
} from "./constants.js";
import { AlertGoneError, AlertsUnavailableError, type SecurityPorts } from "./ports.js";
import { readBack, readerWords, sameWords } from "./read_back.js";
import type {
  AlertItem,
  Created,
  Failed,
  IndexedTicket,
  Result,
  SettleCandidate,
  Settled,
  SkippedRepo,
  State,
} from "./schemas.js";
import { alertOutcome, alertUrl, parseRawAlert, SOURCES } from "./sources.js";
import { settleComment, ticketBody, ticketTitle } from "./texts.js";
import { workspaceForOwner, type Workspace } from "./workspaces.js";

const sourceKey = (repository: string, source: GhsecSource): string => `${repository}:${source}`;

/** The owner, or the owner and repository, a target names; anything else names the two accepted forms. */
export function parseTarget(target: string): { owner: string; repo?: string } {
  const trimmed = target.trim();
  const forms = `an owner ("zachbornheimer") or an owner/repository ("Software-Automation-Holdings-LLC/auth")`;
  if (trimmed === "" || /\s/.test(trimmed)) throw new Error(`"${target}" names neither of the two accepted forms: ${forms}`);
  const parts = trimmed.split("/");
  if (parts.length === 1) return { owner: trimmed };
  if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") return { owner: parts[0]!, repo: parts[1]! };
  throw new Error(`"${target}" names neither of the two accepted forms: ${forms}`);
}

export type SecurityScope = {
  owner: string;
  workspace: Workspace;
  visitedRepos: string[];
  skippedRepos: SkippedRepo[];
};

/**
 * REMOTE read-only (GitHub): the repositories the target names — the one an `owner/repo` target names, or every
 * non-archived repository of an owner target, the archived ones counted as skipped — and the Linear workspace the
 * owner routes to.
 */
export async function resolveSecurityScope(
  ports: Pick<SecurityPorts, "gh">,
  input: { target: string },
  table?: readonly Workspace[],
): Promise<SecurityScope> {
  const { owner, repo } = parseTarget(input.target);
  const workspace = workspaceForOwner(owner, table);
  const skippedRepos: SkippedRepo[] = [];
  let visitedRepos: string[];
  if (repo !== undefined) {
    visitedRepos = [`${owner}/${repo}`];
  } else {
    const listing = await ports.gh.listRepos(owner);
    visitedRepos = listing.filter((repository) => !repository.isArchived).map((repository) => `${owner}/${repository.name}`);
    for (const repository of listing.filter((entry) => entry.isArchived)) {
      skippedRepos.push({ repo: `${owner}/${repository.name}`, reason: "archived" });
    }
  }
  return { owner, workspace, visitedRepos, skippedRepos };
}

export type ListedItems = { items: AlertItem[]; skipped: SkippedRepo[]; listed: string[]; unlisted: string[] };

/**
 * REMOTE read-only (GitHub): every open security alert of every visited repository, one item per alert, tagged. A
 * repository whose source answers 403 or 404 (the feature is off, no access, an empty repository) is skipped with the
 * GitHub message and the run continues; any other failure fails the run naming the repository. Only `SWEEP_SOURCES`
 * are read: Dependabot alerts belong to `upgrade_bot_prs`. Items come back critical first, then high, medium and low.
 * `listed` and `unlisted` name the sources that answered and the ones that did not, so a ticket of a source that could
 * not be read is never mistaken for one whose alert is closed.
 */
export async function listGhSecurityItems(
  ports: Pick<SecurityPorts, "gh" | "throwIfCancelled" | "progress">,
  input: { visitedRepos: readonly string[] },
): Promise<ListedItems> {
  const items: AlertItem[] = [];
  const skipped: SkippedRepo[] = [];
  const listed: string[] = [];
  const unlisted: string[] = [];
  for (const repository of input.visitedRepos) {
    const [owner, repo] = repository.split("/");
    for (const source of SWEEP_SOURCES) {
      ports.throwIfCancelled();
      ports.progress(`reading ${source} alerts of ${repository}`);
      let alerts: unknown[];
      try {
        alerts = await ports.gh.listAlerts({ source, owner: owner!, repo: repo! });
      } catch (error) {
        if (error instanceof AlertsUnavailableError) {
          skipped.push({ repo: repository, reason: error.reason });
          unlisted.push(sourceKey(repository, source));
          continue;
        }
        throw error;
      }
      listed.push(sourceKey(repository, source));
      const spec = SOURCES[source];
      for (const raw of alerts) {
        const alert = parseRawAlert(raw);
        if (alert === undefined || !spec.isSecurityAlert(alert)) continue;
        items.push({
          tag: ghsecTag({ owner: owner!, repo: repo!, source, number: alert.number }),
          source,
          number: alert.number,
          severity: spec.severityOf(alert),
          url: alert.html_url,
          outcome: spec.outcomeOf(alert),
          detail: spec.detailOf(alert),
          state: "open",
          repo: repository,
        });
      }
    }
  }
  return { items: items.sort(bySeverityDescending), skipped, listed, unlisted };
}

/**
 * REMOTE read-only (Linear): the workspace's issues whose title carries a ghsec tag, one read, indexed by tag. A ticket
 * whose title carries no parsable tag is not indexed, so nothing this run cannot name is ever touched.
 */
export async function indexExistingGhsecTickets(
  ports: Pick<SecurityPorts, "linear">,
  input: { workspace: Workspace },
): Promise<Record<string, IndexedTicket>> {
  const issues = await ports.linear.searchIssues(input.workspace, "ghsec:");
  const index: Record<string, IndexedTicket> = {};
  for (const issue of issues) {
    const tag = findGhsecTag(issue.title);
    if (tag === undefined) continue;
    if (index[tag] === undefined) index[tag] = { identifier: issue.identifier, status: issue.status };
  }
  return index;
}

export type Reconciliation = {
  /** The alerts at or above `minSeverity` no ticket carries: one ticket each is created. */
  toCreate: AlertItem[];
  /** The indexed tickets whose alert is no longer open in a repository this run visited: one moved to done each. */
  toSettle: SettleCandidate[];
  /** The alerts at or above `minSeverity` a ticket already carries. */
  existing: number;
};

/**
 * The one diff of the run, pure: no port, no clock, no randomness. An indexed ticket settles only when its tag parses,
 * names a repository this run visited, its source could be listed this run, and the alert is not among the open
 * alerts GitHub just answered — so a ticket whose alert is open but below `minSeverity` is untouched, and so is any
 * ticket this run never visited or could not read. `toCreate` is critical first, ties by tag.
 */
export function reconcileGhsecTickets(input: {
  items: readonly AlertItem[];
  index: Record<string, IndexedTicket>;
  visitedRepos: readonly string[];
  minSeverity: AlertItem["severity"];
  unlisted?: readonly string[];
}): Reconciliation {
  const floor = severityRank(input.minSeverity);
  const filed = input.items.filter((item) => severityRank(item.severity) <= floor);
  const openTags = new Set(input.items.map((item) => item.tag));
  const unlisted = new Set(input.unlisted ?? []);
  const toCreate = filed
    .filter((item) => input.index[item.tag] === undefined)
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.tag.localeCompare(right.tag));
  const existing = filed.filter((item) => input.index[item.tag] !== undefined).length;
  const toSettle = Object.entries(input.index)
    .filter(([tag]) => {
      const parts = parseGhsecTag(tag);
      if (parts === undefined) return false;
      const repository = `${parts.owner}/${parts.repo}`;
      return input.visitedRepos.includes(repository)
        && !unlisted.has(sourceKey(repository, parts.source))
        && !openTags.has(tag);
    })
    .map(([tag, ticket]) => ({ tag, identifier: ticket.identifier, status: ticket.status }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
  return { toCreate, toSettle, existing };
}

export type CreationOutcome = { created: Created[]; failed: Failed[] };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * REMOTE (Linear): one ticket per missing alert, in the workspace the owner routes to. The status is the workspace's
 * first input status, found by name at run time through the team's own status list; the priority is the severity's;
 * the `Security` label is used only when the workspace already has one by that name (none is ever created). Every
 * create is read back — the read must show the tag in the title and the input status — through the one read-back
 * policy; a ticket that does not settle is recorded in `failed` and the run continues.
 */
export async function createMissingGhsecTickets(
  ports: Pick<SecurityPorts, "linear" | "sleep" | "throwIfCancelled" | "progress">,
  input: { workspace: Workspace; toCreate: readonly AlertItem[] },
): Promise<CreationOutcome> {
  const outcome: CreationOutcome = { created: [], failed: [] };
  if (input.toCreate.length === 0) return outcome;
  const statuses = await ports.linear.listStatuses(input.workspace);
  const firstInput = input.workspace.inputs[0]!;
  const inputStatus = statuses.find((status) => status.name === firstInput);
  if (inputStatus === undefined) {
    throw new Error(
      `Linear has no status named "${firstInput}" for the ${input.workspace.team} team; the team has: ${statuses.map((status) => status.name).join(", ")}`,
    );
  }
  const security = await ports.linear.findLabel(input.workspace, SECURITY_LABEL);
  for (const item of input.toCreate) {
    ports.throwIfCancelled();
    ports.progress(`creating ticket for ${item.tag}`);
    try {
      const { identifier } = await ports.linear.createIssue(input.workspace, {
        title: ticketTitle(item),
        description: ticketBody(item),
        priority: SEVERITY_PRIORITY[item.severity],
        stateId: inputStatus.id,
        ...(security === undefined ? {} : { labelIds: [security.id] }),
      });
      await readBack(ports.sleep, async () => {
        const read = await ports.linear.getIssue(input.workspace, identifier);
        if (read.status !== firstInput) {
          return `Linear write not visible on ${identifier}: asked for status "${firstInput}", the read-back says "${read.status}"`;
        }
        if (!readerWords(read.title).includes(readerWords(item.tag))) {
          return `Linear write not visible on ${identifier}: the read-back title carries no ${item.tag}`;
        }
        return undefined;
      });
      outcome.created.push({ identifier, tag: item.tag });
    } catch (error) {
      ports.throwIfCancelled();
      outcome.failed.push({ tag: item.tag, reason: message(error) });
    }
  }
  return outcome;
}

export type SettleOutcome = { settled: Settled[]; failed: Failed[] };

/**
 * REMOTE (Linear, GitHub): one indexed ticket per alert GitHub no longer shows open, in a repository this run visited.
 * Each alert is read again before the ticket moves — an alert that reads open again is left exactly as it is, never
 * reopened and never touched — then the ticket goes to the workspace's done status (its own name, found at run
 * time) with a comment naming the GitHub state, the dismissal reason when there was one, the alert URL and the date.
 * GitHub answers 404 for a missing alert and also for a source it will not show this token, so a 404 counts as
 * "gone" only when the source's listing answered this run (or answers now); otherwise the ticket is left alone and
 * recorded in `failed`. Every write is read back; a ticket that does not settle is recorded in `failed`.
 */
export async function settleResolvedGhsecTickets(
  ports: Pick<SecurityPorts, "gh" | "linear" | "sleep" | "today" | "throwIfCancelled" | "progress">,
  input: { workspace: Workspace; toSettle: readonly SettleCandidate[]; listed?: readonly string[] },
): Promise<SettleOutcome> {
  const outcome: SettleOutcome = { settled: [], failed: [] };
  if (input.toSettle.length === 0) return outcome;
  const statuses = await ports.linear.listStatuses(input.workspace);
  const done = statuses.find((status) => status.name === input.workspace.done);
  if (done === undefined) {
    throw new Error(
      `Linear has no status named "${input.workspace.done}" for the ${input.workspace.team} team; the team has: ${statuses.map((status) => status.name).join(", ")}`,
    );
  }
  const date = ports.today();
  /** Listings known to answer: the sweep's own, plus any confirmed here. */
  const answering = new Set(input.listed ?? []);
  /** Whether the source's listing answers for the repository; one `gh` call per source and repository. */
  const listingAnswers = async (repository: string, source: GhsecSource, owner: string, repo: string): Promise<boolean> => {
    const key = sourceKey(repository, source);
    if (answering.has(key)) return true;
    try {
      await ports.gh.listAlerts({ source, owner, repo });
    } catch (error) {
      if (error instanceof AlertsUnavailableError) return false;
      throw error;
    }
    answering.add(key);
    return true;
  };

  for (const candidate of input.toSettle) {
    ports.throwIfCancelled();
    ports.progress(`settling ${candidate.identifier}`);
    try {
      const parts = parseGhsecTag(candidate.tag)!;
      const repository = `${parts.owner}/${parts.repo}`;
      let state: string;
      let dismissedReason: string | undefined;
      let url: string;
      try {
        const raw = parseRawAlert(await ports.gh.readAlert(parts));
        if (raw === undefined) throw new Error(`GitHub answered ${repository} ${parts.source} alert ${parts.number} in an unreadable shape`);
        const github = alertOutcome(raw);
        state = github.state;
        dismissedReason = github.dismissedReason;
        url = raw.html_url;
      } catch (error) {
        if (!(error instanceof AlertGoneError)) throw error;
        if (!(await listingAnswers(repository, parts.source, parts.owner, parts.repo))) {
          outcome.failed.push({
            tag: candidate.tag,
            reason: `GitHub answers 404 for this alert and its ${parts.source} listing is not readable, so the ticket was left alone: ${error.message}`,
          });
          continue;
        }
        state = "gone";
        url = alertUrl(parts);
      }
      // The alert stood open again between the listing and this read: the ticket stays exactly where it is.
      if (state === "open") continue;
      await ports.linear.saveIssueState(input.workspace, { ticket: candidate.identifier, stateId: done.id });
      await readBack(ports.sleep, async () => {
        const read = await ports.linear.getIssue(input.workspace, candidate.identifier);
        return read.status === done.name
          ? undefined
          : `Linear write not visible on ${candidate.identifier}: asked for status "${done.name}", the read-back says "${read.status}"`;
      });
      const comment = settleComment({
        tag: candidate.tag,
        githubState: state,
        ...(dismissedReason === undefined ? {} : { dismissedReason }),
        url,
        date,
        done: done.name,
      });
      await ports.linear.saveComment(input.workspace, { ticket: candidate.identifier, body: comment });
      await readBack(ports.sleep, async () => {
        const comments = await ports.linear.listComments(input.workspace, candidate.identifier);
        return comments.some((posted) => sameWords(posted.body, comment))
          ? undefined
          : `Linear write not visible on ${candidate.identifier}: no comment on it carries the body that was posted`;
      });
      outcome.settled.push({ identifier: candidate.identifier, tag: candidate.tag, githubState: state });
    } catch (error) {
      ports.throwIfCancelled();
      if (error instanceof AlertsUnavailableError) {
        outcome.failed.push({ tag: candidate.tag, reason: `the alert could not be read, so the ticket was left alone: ${error.message}` });
        continue;
      }
      outcome.failed.push({ tag: candidate.tag, reason: message(error) });
    }
  }
  return outcome;
}

/** The run's typed result: what was visited, what was found, what was written, and the floor that filtered. */
export function summarizeSecurityTicketRun(state: State): Result {
  const filed = state.items.filter((item) => severityRank(item.severity) <= severityRank(state.minSeverity));
  const bySource: Record<string, number> = {};
  for (const item of filed) bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  return {
    target: state.target,
    dryRun: state.dryRun,
    workspace: { team: state.workspace.team },
    repos: { visited: state.visitedRepos, skipped: state.skippedRepos },
    items: { total: filed.length, bySource },
    tickets: {
      created: state.created,
      existing: state.existing,
      settled: state.settled,
      failed: state.failed,
      wouldCreate: state.dryRun ? state.toCreate.map((item) => item.tag) : [],
      wouldSettle: state.dryRun ? state.toSettle.map((candidate) => candidate.tag) : [],
    },
    minSeverity: state.minSeverity,
  };
}
