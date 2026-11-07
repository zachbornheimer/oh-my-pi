import { arr, bool, obj, optStr, parseJson, parsePaginatedPages, sha, str } from "./decode.js";
import type { CheckRollupEntry, CiReading } from "./ci_verdict.js";
import { command } from "./exec.js";
import type { Runner } from "./exec.js";
import { parsePullRequestUrl } from "./parse_url.js";

/** A PR snapshot; downstream review must use these exact commits. */
export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  description: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

/** Reads a PR snapshot, refusing a PR that is not open or that GitHub answers for under another identity. */
export async function getPullRequest(run: Runner, prUrl: string): Promise<PullRequest> {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  const where = "gh pr view";
  const details = obj(
    parseJson(
      await command(run, "gh", [
        "pr",
        "view",
        String(number),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "url,title,body,baseRefName,baseRefOid,headRefOid,state",
      ]),
      where,
    ),
    where,
  );
  const state = str(details.state, `${where} state`);
  if (state !== "OPEN") throw new Error(`Pull request is not open: ${prUrl}`);
  const url = str(details.url, `${where} url`);
  const canonical = parsePullRequestUrl(url);
  if (
    canonical.number !== number || canonical.owner.toLowerCase() !== owner.toLowerCase()
    || canonical.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error("GitHub returned a different PR");
  }
  const baseRef = str(details.baseRefName, `${where} baseRefName`);
  if (baseRef === "") throw new Error(`${where} baseRefName: expected a non-empty string`);
  return {
    owner,
    repo,
    number,
    url,
    title: str(details.title, `${where} title`),
    description: optStr(details.body, `${where} body`) ?? "",
    baseRef,
    baseSha: sha(details.baseRefOid, `${where} baseRefOid`),
    headSha: sha(details.headRefOid, `${where} headRefOid`),
  };
}

/** Reads GitHub's current head and its aggregated checks in one operation. */
export async function readCi(run: Runner, prUrl: string): Promise<CiReading> {
  const where = "gh pr view headRefOid,statusCheckRollup";
  const view = obj(
    parseJson(await command(run, "gh", ["pr", "view", prUrl, "--json", "headRefOid,statusCheckRollup"]), where),
    where,
  );
  const rollup = view.statusCheckRollup === null || view.statusCheckRollup === undefined
    ? []
    : arr(view.statusCheckRollup, `${where} statusCheckRollup`).map((entry, index): CheckRollupEntry => {
      const check = obj(entry, `${where} statusCheckRollup[${index}]`);
      return {
        __typename: str(check.__typename, `statusCheckRollup[${index}].__typename`),
        ...(check.name === undefined ? {} : { name: str(check.name, "name") }),
        ...(check.context === undefined ? {} : { context: str(check.context, "context") }),
        ...(check.status === undefined ? {} : { status: optStr(check.status, "status") ?? null }),
        ...(check.conclusion === undefined ? {} : { conclusion: optStr(check.conclusion, "conclusion") ?? null }),
        ...(check.state === undefined ? {} : { state: optStr(check.state, "state") ?? null }),
      };
    });
  return { headSha: sha(view.headRefOid, `${where} headRefOid`), rollup };
}

interface ReviewComment {
  body: string;
  path?: string | null;
  author: { login: string } | null;
  authorAssociation?: string;
}

/** One inline review thread: its first and its latest comment. */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  initial: { nodes: ReviewComment[] };
  latest: { nodes: ReviewComment[] };
}

function comment(value: unknown, where: string): ReviewComment {
  const node = obj(value, where);
  const author = node.author === null || node.author === undefined
    ? null
    : { login: str(obj(node.author, `${where}.author`).login, `${where}.author.login`) };
  return {
    body: str(node.body, `${where}.body`),
    path: optStr(node.path, `${where}.path`) ?? null,
    author,
    ...(node.authorAssociation === undefined ? {} : { authorAssociation: str(node.authorAssociation, "authorAssociation") }),
  };
}

function commentNodes(value: unknown, where: string): ReviewComment[] {
  return arr(obj(value, where).nodes, `${where}.nodes`).map((node, index) => comment(node, `${where}.nodes[${index}]`));
}

// gh api --paginate requires the $endCursor variable and pageInfo on the connection.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          initial: comments(first: 1) { nodes { body path author { login } authorAssociation } }
          latest: comments(last: 1) { nodes { body path author { login } authorAssociation } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Returns all unresolved inline review threads, including paginated results. */
export async function unresolvedReviewThreads(run: Runner, pr: PullRequest): Promise<ReviewThread[]> {
  const stdout = await command(run, "gh", [
    "api",
    "graphql",
    "--paginate",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-f",
    `owner=${pr.owner}`,
    "-f",
    `repo=${pr.repo}`,
    "-F",
    `number=${pr.number}`,
  ]);
  const threads: ReviewThread[] = [];
  for (const [index, page] of parsePaginatedPages(stdout).entries()) {
    const where = `review threads page ${index}`;
    const data = obj(obj(page, where).data, `${where}.data`);
    const connection = obj(
      obj(obj(data.repository, `${where}.repository`).pullRequest, `${where}.pullRequest`).reviewThreads,
      `${where}.reviewThreads`,
    );
    for (const [at, node] of arr(connection.nodes, `${where}.nodes`).entries()) {
      const thread = obj(node, `${where}.nodes[${at}]`);
      const resolved = bool(thread.isResolved, `${where}.nodes[${at}].isResolved`);
      if (resolved) continue;
      threads.push({
        id: str(thread.id, `${where}.nodes[${at}].id`),
        isResolved: false,
        initial: { nodes: commentNodes(thread.initial, `${where}.nodes[${at}].initial`) },
        latest: { nodes: commentNodes(thread.latest, `${where}.nodes[${at}].latest`) },
      });
    }
  }
  return threads;
}
