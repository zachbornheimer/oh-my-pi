import { type CheckRollupEntry, ciVerdict } from "./ci_verdict.js";
import { ISSUE_BODY_CAP } from "./constants.js";
import { arr, bool, obj, type Obj, optStr, parsePaginatedPages, sha, str } from "./decode.js";
import { ghRead } from "./gh_read.js";
import { parsePullRequestUrl } from "./parse_url.js";
import type { GitHubPorts } from "./ports.js";
import type { Facts, Note, PrState, Thread } from "./types.js";

const BOT = /\[bot\]$|^dependabot$|^renovate$/i;
const TRUSTED: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** A review in this state says nothing a fix could answer. */
const SAYS_NOTHING_TO_FIX: ReadonlySet<string> = new Set(["APPROVED", "DISMISSED", "PENDING"]);
const PR_STATES: ReadonlySet<string> = new Set(["OPEN", "CLOSED", "MERGED"]);

const VIEW_FIELDS = [
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "isCrossRepository",
  "headRepository",
  "headRepositoryOwner",
  "reviewDecision",
  "mergeStateStatus",
  "author",
  "statusCheckRollup",
].join(",");

const THREADS_QUERY = `
query PrThreads($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          comments(first: 1) { nodes { body path url author { login } authorAssociation } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const COMMENTS_QUERY = `
query PrComments($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100, after: $endCursor) {
        nodes { id body createdAt authorAssociation author { __typename login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const REVIEWS_QUERY = `
query PrReviews($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $endCursor) {
        nodes { id body state submittedAt authorAssociation commit { oid } author { __typename login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface Actor {
  login: string;
  typename: string | undefined;
}

/** `null` is a deleted account (GitHub's "ghost"). `__typename` is how GraphQL tells a bot from a person. */
function actor(value: unknown, where: string): Actor | null {
  if (value === null || value === undefined) return null;
  const node = obj(value, where);
  return { login: str(node.login, `${where}.login`), typename: optStr(node.__typename, `${where}.__typename`) };
}

async function ghJson(ports: GitHubPorts, args: readonly string[]): Promise<unknown> {
  const text = await ghRead(ports, args);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} returned something unreadable: ${(error as Error).message}`);
  }
}

function clip(text: string): string {
  return text.length <= ISSUE_BODY_CAP ? text : `${text.slice(0, ISSUE_BODY_CAP)}\n…[truncated]`;
}

/**
 * When the current head reached GitHub: its check suites are created by the push, so the earliest one is the push time;
 * a repository with no check suites falls back to the commit's own date, which a push can only follow.
 */
async function readHeadPushedAt(ports: GitHubPorts, repo: string, headSha: string): Promise<string> {
  const [suites, commit] = await Promise.all([
    ghJson(ports, ["api", `repos/${repo}/commits/${headSha}/check-suites`]),
    ghJson(ports, ["api", `repos/${repo}/commits/${headSha}`]),
  ]);
  const suiteMs = arr(obj(suites, "check-suites").check_suites, "check_suites").map((suite, index) =>
    Date.parse(str(obj(suite, `check_suites[${index}]`).created_at, `check_suites[${index}].created_at`))
  );
  const committer = obj(obj(obj(commit, "commit").commit, "commit.commit").committer, "commit.commit.committer");
  const commitMs = Date.parse(str(committer.date, "committer.date"));
  const pushed = suiteMs.length === 0 ? commitMs : Math.max(commitMs, Math.min(...suiteMs));
  if (Number.isNaN(pushed)) throw new Error(`unreadable push time for ${repo}@${headSha}`);
  return new Date(pushed).toISOString();
}

type Pull = { owner: string; repo: string; number: number };

/** One paginated GraphQL read of the pull request; every page, so more than 100 threads or comments is not silently cut. */
async function readPages(ports: GitHubPorts, query: string, pull: Pull, connection: string): Promise<Obj[]> {
  const raw = await ports.gh([
    "api",
    "graphql",
    "--paginate",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${pull.owner}`,
    "-f",
    `repo=${pull.repo}`,
    "-F",
    `number=${pull.number}`,
  ]);
  return parsePaginatedPages(raw).flatMap((page, index) => {
    const where = `${connection} page ${index}`;
    const data = obj(obj(page, where).data, `${where}.data`);
    const pullRequest = obj(obj(data.repository, `${where}.repository`).pullRequest, `${where}.pullRequest`);
    return arr(obj(pullRequest[connection], `${where}.${connection}`).nodes, `${where}.${connection}.nodes`).map(
      (node, at) => obj(node, `${where}.nodes[${at}]`),
    );
  });
}

async function readUnresolvedThreads(ports: GitHubPorts, pull: Pull): Promise<Thread[]> {
  const nodes = await readPages(ports, THREADS_QUERY, pull, "reviewThreads");
  return nodes.filter((thread) => !bool(thread.isResolved, "thread.isResolved")).map((thread): Thread => {
    const comments = arr(obj(thread.comments, "thread.comments").nodes, "thread.comments.nodes");
    const first = comments[0] === undefined ? undefined : obj(comments[0], "thread.comments.nodes[0]");
    return {
      id: str(thread.id, "thread.id"),
      path: optStr(first?.path, "comment.path") ?? "",
      url: optStr(first?.url, "comment.url") ?? "",
      author: actor(first?.author, "comment.author")?.login ?? "ghost",
      body: clip(optStr(first?.body, "comment.body") ?? ""),
    };
  });
}

function checksOf(rollup: readonly CheckRollupEntry[]): Facts["checks"] {
  const name = (check: CheckRollupEntry): string => check.name || check.context || "check";
  return {
    verdict: ciVerdict(rollup),
    failed: rollup.filter((check) => ciVerdict([check]) === "red").map(name),
    pending: rollup.filter((check) => ciVerdict([check]) === "pending").map(name),
  };
}

function isBot(who: Actor | null): boolean {
  return who !== null && (who.typename === "Bot" || BOT.test(who.login));
}

interface RawReview {
  id: string;
  body: string;
  state: string;
  submittedAt: string | null;
  association: string;
  commitSha: string;
  author: Actor | null;
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  association: string;
  author: Actor | null;
}

function rawReview(node: Obj): RawReview {
  const commit = node.commit === null || node.commit === undefined ? undefined : obj(node.commit, "review.commit");
  return {
    id: str(node.id, "review.id"),
    body: str(node.body, "review.body"),
    state: str(node.state, "review.state"),
    submittedAt: optStr(node.submittedAt, "review.submittedAt") ?? null,
    association: optStr(node.authorAssociation, "review.authorAssociation") ?? "",
    commitSha: commit === undefined ? "" : str(commit.oid, "review.commit.oid"),
    author: actor(node.author, "review.author"),
  };
}

function rawComment(node: Obj): RawComment {
  return {
    id: str(node.id, "comment.id"),
    body: str(node.body, "comment.body"),
    createdAt: str(node.createdAt, "comment.createdAt"),
    association: optStr(node.authorAssociation, "comment.authorAssociation") ?? "",
    author: actor(node.author, "comment.author"),
  };
}

/** Each reviewer's latest submitted review. The author and the viewer reply to threads; they do not review. */
function reviewersOf(reviews: readonly RawReview[], excluded: ReadonlySet<string>): Facts["reviewers"] {
  const latest = new Map<string, Facts["reviewers"][number]>();
  for (const review of reviews) {
    const login = review.author?.login;
    if (login === undefined || excluded.has(login) || review.state === "PENDING" || review.submittedAt === null) {
      continue;
    }
    const seen = latest.get(login);
    if (seen !== undefined && Date.parse(seen.submittedAt) > Date.parse(review.submittedAt)) continue;
    latest.set(login, { login, state: review.state, commitSha: review.commitSha, submittedAt: review.submittedAt });
  }
  return [...latest.values()];
}

type RawNote = { id: string; source: Note["source"]; actor: Actor | null; association: string; body: string; at: string };

/** Rule 2: a human comment or review body is open until a fix is pushed after it. Bots, the author and the viewer are not asked. */
function openCommentsOf(
  comments: readonly RawComment[],
  reviews: readonly RawReview[],
  excluded: ReadonlySet<string>,
  headPushedAt: string,
): Note[] {
  const pushed = Date.parse(headPushedAt);
  const notes: RawNote[] = [
    ...comments.map((comment) => ({
      id: comment.id,
      source: "comment" as const,
      actor: comment.author,
      association: comment.association,
      body: comment.body,
      at: comment.createdAt,
    })),
    ...reviews.filter((review) => !SAYS_NOTHING_TO_FIX.has(review.state)).map((review) => ({
      id: review.id,
      source: "review" as const,
      actor: review.author,
      association: review.association,
      body: review.body,
      at: review.submittedAt ?? "",
    })),
  ];
  return notes
    .filter((note) =>
      note.body.trim() !== "" && !isBot(note.actor) && !excluded.has(note.actor?.login ?? "")
      && Date.parse(note.at) > pushed
    )
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map((note) => ({
      id: note.id,
      source: note.source,
      author: note.actor?.login ?? "ghost",
      trusted: TRUSTED.has(note.association),
      body: clip(note.body),
      at: note.at,
    }));
}

function rollupOf(value: unknown): CheckRollupEntry[] {
  if (value === null || value === undefined) return [];
  return arr(value, "statusCheckRollup").map((entry, index): CheckRollupEntry => {
    const check = obj(entry, `statusCheckRollup[${index}]`);
    const out: CheckRollupEntry = { __typename: str(check.__typename, `statusCheckRollup[${index}].__typename`) };
    if (check.name !== undefined) out.name = str(check.name, "check.name");
    if (check.context !== undefined) out.context = str(check.context, "check.context");
    if (check.status !== undefined) out.status = optStr(check.status, "check.status") ?? null;
    if (check.conclusion !== undefined) out.conclusion = optStr(check.conclusion, "check.conclusion") ?? null;
    if (check.state !== undefined) out.state = optStr(check.state, "check.state") ?? null;
    return out;
  });
}

/**
 * Reads everything rule 5 asks about one pull request head, at one moment: unresolved threads, comments no pushed fix
 * follows, the check rollup, each reviewer's latest review against the head, review decision, merge state, the head
 * SHA and when it was pushed, and whether the viewer can push. It judges nothing.
 */
export async function readFacts(ports: GitHubPorts, prUrl: string): Promise<Facts> {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  const nameWithOwner = `${owner}/${repo}`;
  const pull = { owner, repo, number };
  const [viewRaw, userRaw, repositoryRaw, threads, commentNodes, reviewNodes] = await Promise.all([
    ghJson(ports, ["pr", "view", String(number), "--repo", nameWithOwner, "--json", VIEW_FIELDS]),
    ghJson(ports, ["api", "user"]),
    ghJson(ports, ["api", `repos/${nameWithOwner}`]),
    readUnresolvedThreads(ports, pull),
    readPages(ports, COMMENTS_QUERY, pull, "comments"),
    readPages(ports, REVIEWS_QUERY, pull, "reviews"),
  ]);
  const view = obj(viewRaw, "gh pr view");
  const state = str(view.state, "gh pr view state");
  if (!PR_STATES.has(state)) throw new Error(`gh pr view state: unexpected ${state}`);
  const headSha = sha(view.headRefOid, "gh pr view headRefOid");
  const viewer = str(obj(userRaw, "gh api user").login, "gh api user login");
  if (viewer === "") throw new Error("gh api user login: expected a non-empty string");
  const permissionsRaw = obj(repositoryRaw, "repository").permissions;
  const permissions = permissionsRaw === undefined || permissionsRaw === null ? {} : obj(permissionsRaw, "permissions");
  const comments = commentNodes.map(rawComment);
  const reviews = reviewNodes.map(rawReview);
  const headPushedAt = await readHeadPushedAt(ports, nameWithOwner, headSha);
  const author = actor(view.author, "gh pr view author")?.login ?? "ghost";
  const excluded: ReadonlySet<string> = new Set([author, viewer]);
  const isCrossRepository = bool(view.isCrossRepository, "gh pr view isCrossRepository");
  const headOwner = actor(view.headRepositoryOwner, "headRepositoryOwner")?.login ?? author;
  const headRepository = view.headRepository === null || view.headRepository === undefined
    ? undefined
    : obj(view.headRepository, "headRepository");
  const headName = optStr(headRepository?.name, "headRepository.name") ?? repo;
  const headRepo = optStr(headRepository?.nameWithOwner, "headRepository.nameWithOwner")
    || (isCrossRepository ? `${headOwner}/${headName}` : nameWithOwner);
  return {
    prUrl,
    repo: nameWithOwner,
    number,
    baseRef: str(view.baseRefName, "gh pr view baseRefName"),
    headRef: str(view.headRefName, "gh pr view headRefName"),
    headSha,
    headPushedAt,
    observedAt: ports.now().toISOString(),
    author,
    state: state as PrState,
    isDraft: bool(view.isDraft, "gh pr view isDraft"),
    viewer,
    viewerCanPush: permissions.push === true || permissions.maintain === true || permissions.admin === true,
    isCrossRepository,
    ...(isCrossRepository ? { headRepo } : {}),
    reviewDecision: optStr(view.reviewDecision, "gh pr view reviewDecision") ?? "",
    mergeStateStatus: str(view.mergeStateStatus, "gh pr view mergeStateStatus"),
    unresolvedThreads: threads,
    openComments: openCommentsOf(comments, reviews, excluded, headPushedAt),
    reviewers: reviewersOf(reviews, excluded),
    checks: checksOf(rollupOf(view.statusCheckRollup)),
  };
}
