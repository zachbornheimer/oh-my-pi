import { NO_PRIORITY, SWEEP_DEFAULT_LIMIT, TICKETS_SKILL } from "./constants.js";
import { type FactoryPorts, type LockHolder, RepositoryUnavailableError } from "./ports.js";
import { languageRequest, REPOSITORY_QUESTION, REWRITE_QUESTION } from "./questions.js";
import {
  type Comment,
  type Issue,
  type IssueSummary,
  type PullRequest,
  type PullRequestRef,
  type Repository,
  type RepositoryAnswer,
  repositoryAnswerShape,
  type RewriteAnswer,
  rewriteAnswerShape,
} from "./schemas.js";
import { obj } from "./shape.js";
import { fillTemplate, parseAnswer } from "./template.js";
import { ticketMaterial } from "./ticket_material.js";
import { isKnownOrg, WORKSPACES, type Workspace, workspaceFor, workspaceOfTeam } from "./workspaces.js";

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
export async function getLinearTicket(ports: Pick<FactoryPorts, "linear">, ticket: string): Promise<LinearTicket> {
  const workspace = workspaceFor(ticket);
  const [issue, comments] = await Promise.all([
    ports.linear.getIssue(workspace, ticket),
    ports.linear.listComments(workspace, ticket),
  ]);
  const linkedPulls = linkedPullRequests([
    ...issue.attachments.map((attachment) => attachment.url),
    issue.title,
    issue.description,
    ...comments.map((comment) => comment.body),
  ]);
  return { workspace, issue, comments, linkedPulls };
}

/**
 * LOCAL: takes the machine-wide factory lock for this run, so only one ticket is worked at a time. Answers the live run
 * that holds it when another run does — so a busy run can name it — and the lock is released when the run finishes,
 * however it ends.
 */
export async function holdFactoryLock(
  ports: Pick<FactoryPorts, "lock">,
  input: { runId: string; ticket: string },
): Promise<{ held: boolean; holder?: LockHolder }> {
  return ports.lock.acquire(input);
}

/** Urgent (1) before Low (4); "No priority" (0) after every real priority. */
function priorityRank(priority: number): number {
  return priority === NO_PRIORITY ? Number.POSITIVE_INFINITY : priority;
}

/** The one upstream answer that means "this workspace simply has no such project", not a failure. */
const UNKNOWN_PROJECT = /could not find project/i;

/** Priority first, then the oldest ticket. Ties on both keep the order they came in (workspace order, then Linear's). */
export function inWorkOrder(issues: readonly IssueSummary[]): IssueSummary[] {
  return [...issues].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/**
 * REMOTE (Linear), read-only: the next tickets to work, from each workspace's own input statuses (every configured
 * workspace unless `teams` names some, and only `project` when one is named), highest priority first and oldest first
 * within a priority, at most `limit` of them (default 1). The tickets may come from different workspaces: they are
 * ordered together, and worked one at a time. A named project is one Linear project, and only some workspaces have it
 * (a sweep of "AI Tooling" reaches the ZYS workspace and no other), so a workspace whose Linear cannot resolve it
 * contributes no tickets instead of failing the whole sweep. Any other failure still propagates.
 */
export async function listEligibleTickets(
  ports: Pick<FactoryPorts, "linear">,
  input: { teams?: readonly string[]; project?: string; limit?: number },
): Promise<string[]> {
  const workspaces = (input.teams ?? WORKSPACES.map((workspace) => workspace.team)).map(workspaceOfTeam);
  const perWorkspace = await Promise.all(
    workspaces.map(async (workspace) => {
      try {
        return (await Promise.all(workspace.inputs.map((status) => ports.linear.listIssues(workspace, status, input.project)))).flat();
      } catch (error) {
        if (input.project !== undefined && error instanceof Error && UNKNOWN_PROJECT.test(error.message)) return [];
        throw error;
      }
    }),
  );
  const unique = new Map<string, IssueSummary>();
  for (const issue of perWorkspace.flat()) unique.set(issue.identifier, issue);
  return inWorkOrder([...unique.values()])
    .slice(0, input.limit ?? SWEEP_DEFAULT_LIMIT)
    .map((issue) => issue.identifier);
}

const REWRITE_FIELD = REWRITE_QUESTION.field;
const REWRITE_REPLY = obj({ [REWRITE_FIELD]: rewriteAnswerShape });

/**
 * MODEL: one question over the ticket, with the text of the `tickets` skill (read at run time from the installed skills)
 * in its instructions. Answers `{ decipherable, description, questions }`: the template-shaped body, or the questions
 * that block it. Writes nothing.
 */
export async function rewriteTicketToTemplate(
  ports: Pick<FactoryPorts, "ask" | "readSkill">,
  input: { issue: Issue; comments: readonly Comment[] },
): Promise<RewriteAnswer> {
  const skill = await ports.readSkill(TICKETS_SKILL);
  const question = {
    ...REWRITE_QUESTION,
    instructions: fillTemplate(REWRITE_QUESTION.instructions, { skill }, "the Rewrite question"),
  };
  const text = await ports.ask({ field: REWRITE_FIELD, prompt: languageRequest(question, ticketMaterial(input.issue, input.comments)) });
  return parseAnswer(text, REWRITE_REPLY, `the ${REWRITE_FIELD} question`)[REWRITE_FIELD] as RewriteAnswer;
}

const REPOSITORY_FIELD = REPOSITORY_QUESTION.field;
const REPOSITORY_REPLY = obj({ [REPOSITORY_FIELD]: repositoryAnswerShape });

/** A GitHub repository name: what `gh repo clone <org>/<name>` takes, and nothing that could steer a path or a flag. */
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type RepositoryIdentity =
  | { found: true; repository: Repository; linkedPullRequest?: PullRequest }
  | { found: false; why: string };

/**
 * The repository's checkout, or the `found: false` answer a repository GitHub cannot resolve earns: it names what the
 * ticket named and what GitHub said, so the ticket is remanded instead of failing the run (and with it the sweep).
 */
async function checkedOut(
  ports: Pick<FactoryPorts, "repos">,
  workspace: Workspace,
  repository: { name: string; org?: string },
  why: string,
): Promise<RepositoryIdentity> {
  try {
    const checkout = await ports.repos.ensureCheckout(workspace, repository);
    return { found: true, repository: { org: checkout.org, name: checkout.repo, checkout: checkout.path, why } };
  } catch (error) {
    if (error instanceof RepositoryUnavailableError) {
      return { found: false, why: `The repository ${error.repository} the ticket names could not be fetched: ${error.reason}` };
    }
    throw error;
  }
}

/**
 * REMOTE read-only (GitHub) then MODEL, then a local clone when the repository has no checkout. A linked pull request names
 * the repository and its organisation (an open one is preferred, and is answered so the work continues on its branch); with
 * none, one question over the ticket and the checkouts under the workspace's roots answers `{ repository, why }`.
 */
export async function identifyTicketRepository(
  ports: Pick<FactoryPorts, "github" | "repos" | "ask">,
  input: { workspace: Workspace; issue: Issue; comments: readonly Comment[]; linkedPulls: readonly PullRequestRef[] },
): Promise<RepositoryIdentity> {
  const linked = await Promise.all(input.linkedPulls.map((pull) => ports.github.readPullRequest(pull.url)));
  const linkedPullRequest = linked.find((pull) => pull.state === "OPEN");
  const named = linkedPullRequest ?? linked[0];
  if (named !== undefined) {
    const identity = await checkedOut(
      ports,
      input.workspace,
      { org: named.org, name: named.repo },
      `the ticket links ${named.url}`,
    );
    return identity.found && linkedPullRequest !== undefined ? { ...identity, linkedPullRequest } : identity;
  }
  const checkouts = await ports.repos.listCheckouts(input.workspace);
  const material = [
    ticketMaterial(input.issue, input.comments),
    "Local repositories:",
    ...new Set(checkouts.map((checkout) => checkout.repo)),
  ].join("\n");
  const text = await ports.ask({ field: REPOSITORY_FIELD, prompt: languageRequest(REPOSITORY_QUESTION, material) });
  let answer: RepositoryAnswer;
  try {
    answer = parseAnswer(text, REPOSITORY_REPLY, `the ${REPOSITORY_FIELD} question`)[REPOSITORY_FIELD] as RepositoryAnswer;
  } catch (error) {
    // An answer in the wrong shape names no repository, and no repository is not a stop: the run works the ticket
    // without a checkout, told why the question could not be read.
    return {
      found: false,
      why: `The ${REPOSITORY_FIELD} question came back in a form this run could not read, so no repository is named: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parts = answer.repository.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const repoName =
    parts.length >= 2 && input.workspace.orgs.some((org) => org.toLowerCase() === parts[0]!.toLowerCase())
      ? parts[1]!
      : (parts[0] ?? "");
  if (repoName === "" || !REPOSITORY_NAME.test(repoName)) {
    return {
      found: false,
      why: `The ${REPOSITORY_FIELD} question named "${answer.repository}", which is not a repository this run can open, so no repository is named. ${answer.why}`,
    };
  }
  return checkedOut(ports, input.workspace, { name: repoName }, answer.why);
}
