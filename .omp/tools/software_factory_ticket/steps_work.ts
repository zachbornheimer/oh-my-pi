import { join } from "node:path";
import { prompt } from "./prompt_files.js";
import { LEFTOVERS_COMMIT_MESSAGE, REVIEW_VERDICT_DIR } from "./constants.js";
import { type FactoryPorts, RepositoryUnavailableError } from "./ports.js";
import {
  type ChangeVerdict,
  changeVerdictShape,
  type Finding,
  type Implementation,
  implementationShape,
  type PublishedPullRequest,
  type PullRequest,
  type PullRequestRef,
  type RepolessWork,
  repolessWorkShape,
  type RootCauseVerdict,
  rootCauseVerdictShape,
  type Worktree,
} from "./schemas.js";
import { fillTemplate, parseAnswer, schemaText } from "./template.js";
import { pullRequestBody } from "./texts.js";
import type { Workspace } from "./workspaces.js";

// ── open_ticket_worktree ────────────────────────────────────────────────────────────────────────────────────────

export type TicketWorktree = { opened: true; worktree: Worktree } | { opened: false; why: string };

/**
 * LOCAL: a worktree of the repository's checkout for the ticket. A linked open PR's head branch is continued, and its base
 * is the PR's; otherwise the ticket's Linear branch name (`sah-123`) is the branch, cut from the default branch
 * (or continued when an earlier run already made it). A checkout whose repository GitHub no longer has answers
 * `{ opened: false, why }`: no repository to work in is the same remand as none identified. Any other git failure throws.
 */
export async function openTicketWorktree(
  ports: Pick<FactoryPorts, "repos">,
  input: { ticket: string; checkout: string; gitBranchName: string; linkedPullRequest?: PullRequest },
): Promise<TicketWorktree> {
  const pull = input.linkedPullRequest;
  try {
    const worktree = await ports.repos.openWorktree({
      checkout: input.checkout,
      ticket: input.ticket,
      branch: pull?.headRef ?? input.gitBranchName,
      ...(pull === undefined ? {} : { base: pull.baseRef }),
    });
    return { opened: true, worktree };
  } catch (error) {
    if (error instanceof RepositoryUnavailableError) {
      return { opened: false, why: `The repository ${error.repository} could not be opened for work: ${error.reason}` };
    }
    throw error;
  }
}

// ── the two adversarial reviews ─────────────────────────────────────────────────────────────────────────────────

export function rootCauseVerdictPath(ticket: string): string {
  return join(REVIEW_VERDICT_DIR, `${ticket}-root-cause.json`);
}

/**
 * MODEL (headless omp, read-only): the adversarial pre-review. Is the ticket's claim real, what is its root cause, or is it a
 * user mistake, done, obsolete or superseded? The reviewer writes one JSON verdict file that is parsed against the
 * verdict shape; a missing or malformed file throws. A ticket with no repository has no checkout: the review then reads the
 * ticket's own material and runs in a scratch directory.
 */
export async function reviewTicketRootCauseWithOmp(
  ports: Pick<FactoryPorts, "review">,
  input: {
    ticket: string;
    body: string;
    /** The checkout the review reads; absent for a ticket with no repository, which the review judges on its own material. */
    worktree?: { path: string; branch: string; base: string };
    /** Why the ticket has no repository at all, from the run's own repository question. */
    noRepositoryWhy?: string;
    linkedPulls: readonly PullRequestRef[];
  },
): Promise<RootCauseVerdict> {
  const verdictPath = rootCauseVerdictPath(input.ticket);
  const checkout =
    input.worktree === undefined
      ? `No repository was identified for this ticket${input.noRepositoryWhy === undefined ? "" : ` (${input.noRepositoryWhy})`}, so there is no checkout to read: judge the claim on the ticket's own material and on what you can reach from here — the hosts, services and accounts the ticket names — and set \`workInThisCheckout\` false.`
      : `The repository is checked out at your working directory \`${input.worktree.path}\` (branch \`${input.worktree.branch}\`, based on \`${input.worktree.base}\`).`;
  const text = fillTemplate(prompt("review_root_cause.md"), {
    ticket: input.ticket,
    body: input.body,
    checkout,
    linkedPullRequests: input.linkedPulls.length === 0 ? "none" : input.linkedPulls.map((pull) => pull.url).join(", "),
    verdictPath,
    schema: schemaText(rootCauseVerdictShape),
  }, "review_root_cause.md");
  const answer = await ports.review({ ...(input.worktree === undefined ? {} : { worktree: input.worktree.path }), prompt: text, verdictPath });
  return parseAnswer(answer, rootCauseVerdictShape, `the root-cause review of ${input.ticket}`);
}

export function changeVerdictPath(ticket: string, round: number): string {
  return join(REVIEW_VERDICT_DIR, `${ticket}-change-round-${round}.json`);
}

/**
 * MODEL (headless omp, read-only): the adversarial post-review of `git diff <base>...HEAD` in the worktree, against the ticket
 * body as the verbatim outcome. Answers BLOCK, CONCERNS or CLEAN with findings; the verdict file is parsed against its shape.
 */
export async function reviewBranchChangeWithOmp(
  ports: Pick<FactoryPorts, "review">,
  input: {
    ticket: string;
    body: string;
    round: number;
    makerSummary: string;
    worktree: { path: string; branch: string; base: string };
  },
): Promise<ChangeVerdict> {
  const verdictPath = changeVerdictPath(input.ticket, input.round);
  const text = fillTemplate(prompt("review_change.md"), {
    ticket: input.ticket,
    body: input.body,
    worktree: input.worktree.path,
    branch: input.worktree.branch,
    base: input.worktree.base,
    makerSummary: input.makerSummary,
    verdictPath,
    schema: schemaText(changeVerdictShape),
  }, "review_change.md");
  const answer = await ports.review({ worktree: input.worktree.path, prompt: text, verdictPath });
  return parseAnswer(answer, changeVerdictShape, `the change review of ${input.ticket}, round ${input.round}`);
}

// ── implement_ticket_in_worktree ────────────────────────────────────────────────────────────────────────────────

/** What a second round is told: the findings that blocked the first. Nothing when there are none. */
function findingsSection(findings: readonly Finding[]): string {
  if (findings.length === 0) return "";
  return fillTemplate(prompt("blocked_findings.md"), { findings: JSON.stringify(findings, null, 2) }, "blocked_findings.md").trimEnd();
}

/**
 * MODEL (an omp session bound to the worktree) then LOCAL: the agent implements the ticket body, or finds that it is
 * already done, obsolete, superseded or not real, and answers one JSON record. Whatever it left uncommitted is committed
 * afterwards; a `pr_ready` with no commit ahead of the base becomes `needs_info`. It never pushes.
 */
export async function implementTicketInWorktree(
  ports: Pick<FactoryPorts, "implement" | "repos">,
  input: {
    ticket: string;
    body: string;
    worktree: { path: string; branch: string; base: string };
    linkedPullRequest?: string;
    findings: readonly Finding[];
  },
): Promise<Implementation> {
  const text = fillTemplate(prompt("implement_ticket.md"), {
    ticket: input.ticket,
    body: input.body,
    worktree: input.worktree.path,
    branch: input.worktree.branch,
    base: input.worktree.base,
    linkedPullRequest: input.linkedPullRequest ?? "none",
    findings: findingsSection(input.findings),
    schema: schemaText(implementationShape),
  }, "implement_ticket.md");
  const answer = await ports.implement({ worktree: input.worktree.path, branch: input.worktree.branch, prompt: text });
  await ports.repos.commitLeftovers({ worktree: input.worktree.path, message: LEFTOVERS_COMMIT_MESSAGE(input.ticket) });
  const implementation = parseAnswer(answer, implementationShape, `the implementer on ${input.ticket}`);
  if (implementation.outcome !== "pr_ready") return implementation;
  const ahead = await ports.repos.commitsAhead({ worktree: input.worktree.path, base: input.worktree.base });
  if (ahead > 0) return implementation;
  return {
    ...implementation,
    outcome: "needs_info",
    concerns: [...implementation.concerns, `The implementer reported pr_ready, but ${input.worktree.branch} has no commit ahead of ${input.worktree.base}.`],
  };
}

// ── work_ticket_without_checkout ────────────────────────────────────────────────────────────────────────────────

/**
 * What the ticket worker is told about why its ticket has no checkout: which of the two ways the run reached it — no
 * repository was identified, or the pre-work review found the work real but outside the checkout it reviewed.
 */
export function whyNoCheckout(input: { noRepositoryWhy?: string; rootCause?: RootCauseVerdict }): string {
  const lines = [
    input.noRepositoryWhy !== undefined
      ? `No repository was identified for this ticket: ${input.noRepositoryWhy}`
      : undefined,
    input.rootCause?.workInThisCheckout === false
      ? `The pre-work review found the ticket real, but its work does not live in the checkout that was reviewed: ${input.rootCause.rootCause}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join("\n\n") : "No repository was identified for this ticket.";
}

/**
 * LOCAL (no checkout): works a ticket whose work has no repository — web research, the webmaster flows for sites and
 * hosts, a Linear write for what the ticket asks to record — answering one record whose `summary` is the deliverable.
 * Writes nothing itself: what the work writes, it writes as the work, and the run settles the ticket from the record.
 */
export async function workTicketWithoutCheckout(
  ports: Pick<FactoryPorts, "workWithoutCheckout">,
  input: { ticket: string; body: string; noRepositoryWhy?: string; rootCause?: RootCauseVerdict },
): Promise<RepolessWork> {
  const text = fillTemplate(
    prompt("work_without_checkout.md"),
    {
      ticket: input.ticket,
      body: input.body,
      why: whyNoCheckout(input),
      schema: schemaText(repolessWorkShape),
    },
    "work_without_checkout.md",
  );
  const answer = await ports.workWithoutCheckout({ prompt: text });
  return parseAnswer(answer, repolessWorkShape, `the ticket worker on ${input.ticket}`);
}

// ── publish_ticket_pull_request ─────────────────────────────────────────────────────────────────────────────────

export type PublishInput = {
  workspace: Workspace;
  ticket: string;
  ticketTitle: string;
  ticketUrl: string;
  org: string;
  repo: string;
  worktree: { path: string; branch: string; base: string };
  implementation: Implementation;
  changeReview?: ChangeVerdict;
  linkedPullRequest?: PullRequest;
};

/**
 * REMOTE (git push, GitHub): publishes the worktree's branch. `pr_ready` pushes and opens a ready pull request, or pushes to the
 * linked PR's branch and takes that PR out of draft. `needs_info` with commits pushes a **draft** pull request whose body names
 * the ticket and its outstanding concerns; with no commits there is nothing to push and no PR. Every other outcome publishes
 * nothing. The pull request is read back; it throws unless it is open, as drafted, on the branch.
 */
export async function publishTicketPullRequest(
  ports: Pick<FactoryPorts, "github" | "repos">,
  input: PublishInput,
): Promise<PublishedPullRequest | undefined> {
  const { implementation, worktree } = input;
  if (implementation.outcome !== "pr_ready" && implementation.outcome !== "needs_info") return undefined;
  const draft = implementation.outcome === "needs_info";
  const ahead = await ports.repos.commitsAhead({ worktree: worktree.path, base: worktree.base });
  if (ahead === 0) {
    if (draft) return undefined;
    throw new Error(`${input.ticket}: the implementation is pr_ready but ${worktree.branch} has no commit ahead of ${worktree.base}`);
  }
  await ports.repos.push({ worktree: worktree.path, branch: worktree.branch });

  const existing = input.linkedPullRequest;
  if (existing !== undefined) {
    if (!draft && existing.isDraft) await ports.github.markPullRequestReady(existing.url);
    const readBack = await ports.github.readPullRequest(existing.url);
    if (readBack.state !== "OPEN" || (!draft && readBack.isDraft)) {
      throw new Error(`${existing.url}: after the push the pull request is ${readBack.state}${readBack.isDraft ? " and draft" : ""}`);
    }
    return { url: readBack.url, number: readBack.number, draft: readBack.isDraft };
  }

  const url = await ports.github.createPullRequest({
    org: input.org,
    repo: input.repo,
    head: worktree.branch,
    base: worktree.base,
    title: `${input.ticketTitle} (${input.ticket})`,
    body: pullRequestBody({
      ticket: input.ticket,
      ticketUrl: input.ticketUrl,
      summary: implementation.summary,
      concerns: implementation.concerns,
      evidence: implementation.evidence,
      ...(input.changeReview === undefined ? {} : { review: input.changeReview }),
      draft,
      remandedTo: input.workspace.statuses.notReady,
    }),
    draft,
  });
  const readBack = await ports.github.readPullRequest(url);
  if (readBack.state !== "OPEN" || readBack.isDraft !== draft || readBack.headRef !== worktree.branch) {
    throw new Error(
      `${url}: expected an open ${draft ? "draft " : ""}pull request from ${worktree.branch}, read back ${readBack.state} from ${readBack.headRef}${readBack.isDraft ? " (draft)" : ""}`,
    );
  }
  return { url, number: readBack.number, draft };
}
