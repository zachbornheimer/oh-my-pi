// validate_ticket: does a Linear ticket still need doing? Open pull requests are found by a GitHub search run here (a
// fact, not a model's recollection); a full omp session with the user's own setup reads the ticket in Linear and answers
// one JSON object about it; supersession comes from find_superseding_tickets, run here when the caller did not pass it.
// The verdict is composed in code from those three. A ticket that is not in a terminal state has not landed, so an open
// pull request never makes it not_current: it means the work is underway. A superseded ticket is not_current, and its
// open pull requests are then listed so they can be closed with it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type FindSupersedingTicketsOutput,
  runFindSupersedingTickets,
  type SupersedingTicket,
} from "./find_superseding_tickets.js";
import { askObject, type Exec } from "./omp_session.js";
import {
  isObj,
  LINEAR_ID,
  type Obj,
  oneOf,
  reqArray,
  reqBool,
  reqObject,
  reqString,
  reqStringArray,
  ticketId,
} from "./shape.js";
import { validationPrompt } from "./validate_prompt.js";

export const VALIDATE_TICKET_NAME = "validate_ticket";

/** The review reads the ticket and may open the repository or a pull request; it can take a while. */
export const REVIEW_TIMEOUT_MS = 20 * 60_000;
const GH_TIMEOUT_MS = 60_000;
const SEARCH_LIMIT = 30;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export const LINEAR_STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

/** One open pull request the GitHub search returned for the ticket id. */
export interface PullRequestCandidate {
  readonly url: string;
  readonly title: string;
  readonly isDraft: boolean;
}

export interface PullRequest {
  url: string;
  title: string | null;
}

export type PullRequestSearch =
  | { status: "measured"; candidates: number }
  | { status: "unmeasured"; reason: string };

export interface ValidateTicketOutput {
  ticket: string;
  verdict: "current" | "not_current" | "unverified";
  reasons: string[];
  status: string | null;
  status_type: LinearStateType | null;
  already_resolved: boolean | null;
  open_pull_requests: PullRequest[];
  superseded_by: SupersedingTicket[];
  pull_request_search: PullRequestSearch;
  evidence: string;
}

/** What a host provides. Each throws when it cannot run. */
export interface ValidateTicketPorts {
  /** Open pull requests (the user's account and organizations) whose title or body mention `ticket`. */
  searchPullRequests(ticket: string): Promise<readonly PullRequestCandidate[]>;
  /** The agent's answer to the validation question; `pullRequestCandidates` is the search rendered for the prompt. */
  review(ticket: string, pullRequestCandidates: string): Promise<unknown>;
  /** Which later tickets supersede `ticket`; run only when the caller passed no `supersession`. */
  findSuperseding(ticket: string): Promise<FindSupersedingTicketsOutput>;
}

export interface Review {
  status: string;
  status_type: LinearStateType;
  already_resolved: boolean;
  open_pull_requests: string[];
  evidence: string;
}

/** What the agent answers. Throws, naming the field, when the shape is wrong. A pull request that is not a full URL is a bad answer: it is never a stand-in for one. */
export function reviewOf(value: unknown): Review {
  const object = reqObject(value, "the answer");
  const urls = reqStringArray(object, "open_pull_requests").map((url) => url.trim());
  for (const url of urls) {
    if (!PULL_REQUEST_URL.test(url)) throw new Error(`open_pull_requests entry "${url}" is not a full https://github.com/<owner>/<repo>/pull/<n> URL`);
  }
  return {
    status: reqString(object, "status").trim(),
    status_type: oneOf(object, "status_type", LINEAR_STATE_TYPES),
    already_resolved: reqBool(object, "already_resolved"),
    open_pull_requests: [...new Set(urls)],
    evidence: reqString(object, "evidence"),
  };
}

type Reviewed =
  | { readonly status: "answered"; readonly value: Review }
  | { readonly status: "unanswered"; readonly reason: string };

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The pull request candidates as the prompt lists them. */
export function candidateLines(search: PullRequestSearch, found: readonly PullRequestCandidate[]): string {
  if (search.status === "unmeasured") {
    return `The search failed (${search.reason}). Find open pull requests from the ticket's links in Linear alone.`;
  }
  if (found.length === 0) return "None: no open pull request mentions the ticket.";
  return found.map((pr) => `- ${pr.url} — ${pr.title}${pr.isDraft ? " (draft)" : ""}`).join("\n");
}

/**
 * The supersession a caller passes, checked: `verdict`, `superseded_by` and `evidence` are required (the shape
 * optimize_tooling hands over); `ticket`, `filed_at` and `rejected` are optional. One that names another ticket, or says
 * `superseded` without naming the ticket that supersedes it, is refused: it would mark this ticket not current on no basis.
 */
export function supersessionInputOf(value: unknown, ticket: string): FindSupersedingTicketsOutput {
  const object = reqObject(value, "supersession");
  const named = object.ticket;
  if (named !== undefined && named !== null) {
    if (typeof named !== "string" || named.trim().toUpperCase() !== ticket) {
      throw new Error(`supersession is for ${String(named)}, not ${ticket}`);
    }
  }
  const verdict = oneOf(object, "verdict", ["superseded", "not_superseded", "unverified"] as const);
  const superseded_by = reqArray(object, "superseded_by").map((entry, index): SupersedingTicket => {
    const later = reqObject(entry, `supersession.superseded_by[${index}]`);
    const id = reqString(later, "id").trim().toUpperCase();
    if (!LINEAR_ID.test(id)) throw new Error(`supersession.superseded_by[${index}].id "${id}" is not a Linear identifier`);
    return { id, filed_at: reqString(later, "filed_at"), why: reqString(later, "why") };
  });
  if (verdict === "superseded" && superseded_by.length === 0) {
    throw new Error("supersession says superseded but names no superseding ticket");
  }
  if (verdict !== "superseded" && superseded_by.length > 0) {
    throw new Error(`supersession says ${verdict} but names superseding tickets`);
  }
  const evidence = object.evidence;
  if (typeof evidence !== "string") throw new Error("supersession.evidence must be a string");
  const filed = object.filed_at;
  const rejected = object.rejected;
  return {
    ticket,
    verdict,
    filed_at: typeof filed === "string" ? filed : null,
    superseded_by,
    rejected: Array.isArray(rejected)
      ? rejected.filter(isObj).map((entry: Obj) => ({ id: String(entry.id ?? ""), reason: String(entry.reason ?? "") }))
      : [],
    evidence,
  };
}

/**
 * The verdict, composed from the sources. Anything that shows the ticket is finished or unnecessary wins; otherwise a
 * check that could not run keeps the verdict `unverified` rather than claiming `current`. The pull request search is
 * not among those checks: an open pull request does not change whether the ticket needs doing.
 */
export function verdictOf(
  reviewed: Reviewed,
  supersession: FindSupersedingTicketsOutput,
): Pick<ValidateTicketOutput, "verdict" | "reasons"> {
  const notCurrent: string[] = [];
  if (reviewed.status === "answered") {
    const answer = reviewed.value;
    if (answer.status_type === "completed" || answer.status_type === "canceled") {
      notCurrent.push(`status is "${answer.status}" (${answer.status_type})`);
    }
    if (answer.already_resolved) notCurrent.push("the repository or a merged pull request already delivers it");
  }
  if (supersession.verdict === "superseded") {
    notCurrent.push(
      `superseded by ${supersession.superseded_by.map((later) => `${later.id} (filed ${later.filed_at})`).join(", ")}`,
    );
    if (reviewed.status === "answered" && reviewed.value.open_pull_requests.length > 0) {
      notCurrent.push(`its open pull request(s) should be closed with it: ${reviewed.value.open_pull_requests.join(", ")}`);
    }
  }
  if (notCurrent.length > 0) return { verdict: "not_current", reasons: notCurrent };
  const unverified: string[] = [];
  if (reviewed.status === "unanswered") unverified.push(`review unanswered: ${reviewed.reason}`);
  if (supersession.verdict === "unverified") unverified.push(`supersession unchecked: ${supersession.evidence}`);
  if (unverified.length > 0) return { verdict: "unverified", reasons: unverified };
  return { verdict: "current", reasons: [] };
}

/**
 * Runs the check. Each source that cannot run is recorded, never thrown past the caller; a cancellation still throws.
 * The supersession check and the review run one after the other.
 */
export async function runValidateTicket(
  input: { ticket: string; supersession?: unknown },
  ports: ValidateTicketPorts,
  signal?: AbortSignal,
): Promise<ValidateTicketOutput> {
  const ticket = ticketId(input.ticket);
  const given = input.supersession === undefined || input.supersession === null
    ? undefined
    : supersessionInputOf(input.supersession, ticket);

  const supersession = given ?? await ports.findSuperseding(ticket).catch(
    (error: unknown): FindSupersedingTicketsOutput => {
      signal?.throwIfAborted();
      return { ticket, verdict: "unverified", filed_at: null, superseded_by: [], rejected: [], evidence: reasonOf(error) };
    },
  );

  let found: readonly PullRequestCandidate[] = [];
  let search: PullRequestSearch;
  try {
    found = await ports.searchPullRequests(ticket);
    search = { status: "measured", candidates: found.length };
  } catch (error) {
    signal?.throwIfAborted();
    search = { status: "unmeasured", reason: reasonOf(error) };
  }
  let reviewed: Reviewed;
  try {
    reviewed = { status: "answered", value: reviewOf(await ports.review(ticket, candidateLines(search, found))) };
  } catch (error) {
    signal?.throwIfAborted();
    reviewed = { status: "unanswered", reason: reasonOf(error) };
  }

  const titles = new Map(found.map((pr) => [pr.url, pr.title]));
  const open_pull_requests: PullRequest[] = reviewed.status === "answered"
    ? reviewed.value.open_pull_requests.map((url) => ({ url, title: titles.get(url) ?? null }))
    : [];
  return {
    ticket,
    ...verdictOf(reviewed, supersession),
    status: reviewed.status === "answered" ? reviewed.value.status : null,
    status_type: reviewed.status === "answered" ? reviewed.value.status_type : null,
    already_resolved: reviewed.status === "answered" ? reviewed.value.already_resolved : null,
    open_pull_requests,
    superseded_by: supersession.superseded_by,
    pull_request_search: search,
    evidence: reviewed.status === "answered" ? reviewed.value.evidence : "",
  };
}

export interface LiveDeps {
  exec: Exec;
  signal?: AbortSignal;
  /** Directory the sessions start in. */
  cwd?: string;
  /** Extra directories the review may read to verify delivery; default: the user's `~/Developer` when it exists. */
  addDirs?: readonly string[];
}

/** The signed-in GitHub user and every organization they belong to: the owners a ticket's pull requests can live under. */
export async function githubOwners(gh: (args: string[]) => Promise<string>): Promise<string[]> {
  const [login, orgs] = await Promise.all([
    gh(["api", "user", "--jq", ".login"]),
    gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]),
  ]);
  const owners = [login, ...orgs.split("\n")].map((line) => line.trim()).filter((line) => line !== "");
  // With no owner, `gh search` would search all of GitHub and report strangers' pull requests as this ticket's.
  if (owners.length === 0) throw new Error("gh reported no signed-in GitHub user");
  return [...new Set(owners)];
}

/** The ports for this run: `gh` for the search, full omp sessions for the review and the supersession. */
export function liveValidateTicketPorts(deps: LiveDeps): ValidateTicketPorts {
  const gh = async (args: string[]): Promise<string> => {
    const result = await deps.exec("gh", args, { signal: deps.signal, timeout: GH_TIMEOUT_MS, cwd: deps.cwd });
    if (result.killed) {
      deps.signal?.throwIfAborted();
      throw new Error(`gh ${args.slice(0, 2).join(" ")} was stopped after ${GH_TIMEOUT_MS / 1000} s`);
    }
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 400)}`);
    return result.stdout;
  };
  const developer = join(process.env.HOME || homedir(), "Developer");
  const addDirs = deps.addDirs ?? (existsSync(developer) ? [developer] : []);
  return {
    async searchPullRequests(ticket) {
      const owners = await githubOwners(gh);
      // The ticket id as a phrase: an unquoted ZYS-123 would also match pull requests that mention only ZYS or 123.
      const stdout = await gh([
        "search",
        "prs",
        `"${ticket}"`,
        "--state",
        "open",
        "--match",
        "title,body",
        "--limit",
        String(SEARCH_LIMIT),
        "--json",
        "url,title,isDraft",
        ...owners.flatMap((owner) => ["--owner", owner]),
      ]);
      let rows: unknown;
      try {
        rows = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`gh search prs answered no JSON: ${reasonOf(error)}`);
      }
      if (!Array.isArray(rows)) throw new Error("gh search prs answered no list");
      return rows.map((row, index): PullRequestCandidate => {
        const object = reqObject(row, `gh search row ${index}`);
        return { url: reqString(object, "url"), title: typeof object.title === "string" ? object.title : "", isDraft: object.isDraft === true };
      });
    },
    review: (ticket, pullRequestCandidates) =>
      askObject(deps.exec, validationPrompt(ticket, pullRequestCandidates), reviewOf, {
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal: deps.signal,
        cwd: deps.cwd,
        addDirs,
        label: `validate_ticket ${ticket}`,
      }),
    findSuperseding: (ticket) => runFindSupersedingTickets({ ticket }, { exec: deps.exec, signal: deps.signal, cwd: deps.cwd }),
  };
}
