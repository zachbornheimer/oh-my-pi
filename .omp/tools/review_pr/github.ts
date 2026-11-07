import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arr, bool, int, obj, optStr, parseJson, parsePaginatedPages, sha, str } from "./decode.js";
import type { ChangedFile } from "./diff.js";
import { command, type Runner } from "./exec.js";
import { parsePullRequestUrl } from "./parse_url.js";
import type { Posted, PostedThread, ReviewPlan } from "./plan.js";
import type { PullRequest } from "./types.js";

/** Runs `gh` with the given arguments and returns its stdout; throws `Command failed: gh ...` otherwise. */
export type Gh = (args: readonly string[]) => Promise<string>;

/** The `gh` calls of one run: no shell, the run's abort signal on every call, 5 minutes for any one call. */
export function ghOver(run: Runner, signal?: AbortSignal): Gh {
  return (args) => command(run, "gh", args, { signal, timeoutMs: 5 * 60_000 });
}

/** Reads a PR snapshot, refusing a PR that is not open or that GitHub answers for under another identity. */
export async function getPullRequest(gh: Gh, prUrl: string): Promise<PullRequest> {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  const where = "gh pr view";
  const details = obj(
    parseJson(
      await gh([
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
    canonical.number !== number
    || canonical.owner.toLowerCase() !== owner.toLowerCase()
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

/**
 * The files the PR changes between its merge base and the reviewed head, pinned by SHA so a later push cannot shift the
 * lines a thread anchors to. GitHub lists at most 300 files here; findings in files past that go to the summary.
 */
export async function changedFiles(gh: Gh, pr: PullRequest): Promise<ChangedFile[]> {
  const stdout = await gh([
    "api",
    "--paginate",
    `repos/${pr.owner}/${pr.repo}/compare/${pr.baseSha}...${pr.headSha}?per_page=100`,
  ]);
  const files = new Map<string, ChangedFile>();
  for (const [pageAt, page] of parsePaginatedPages(stdout).entries()) {
    const where = `compare page ${pageAt}`;
    const listed = obj(page, where).files;
    if (listed === undefined || listed === null) continue;
    for (const [at, entry] of arr(listed, `${where}.files`).entries()) {
      const file = obj(entry, `${where}.files[${at}]`);
      const filename = str(file.filename, `${where}.files[${at}].filename`);
      const patch = optStr(file.patch, `${where}.files[${at}].patch`);
      files.set(filename, patch === undefined ? { filename } : { filename, patch });
    }
  }
  return [...files.values()];
}

/** Every inline comment and review body already on the PR, so findings an earlier run posted are not posted again. */
export async function postedOnPullRequest(gh: Gh, pr: PullRequest): Promise<Posted> {
  const bodies = await Promise.all(
    ["comments", "reviews"].map(async (kind) => {
      const stdout = await gh([
        "api",
        "--paginate",
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/${kind}?per_page=100`,
        "--jq",
        ".[] | (.body // \"\") | @json",
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => str(parseJson(line, `${kind} body`), `${kind} body`));
    }),
  );
  return { bodies: bodies.flat() };
}

/** Posts one COMMENT review on the reviewed head: the summary body plus one thread per inline comment. */
export async function postReview(
  gh: Gh,
  pr: PullRequest,
  plan: Pick<ReviewPlan, "body" | "comments">,
): Promise<{ id: number; html_url: string }> {
  const directory = await mkdtemp(join(tmpdir(), "review-pr-post-"));
  try {
    const request = join(directory, "review.json");
    await writeFile(
      request,
      JSON.stringify({ commit_id: pr.headSha, event: "COMMENT", body: plan.body, comments: plan.comments }),
      { mode: 0o600 },
    );
    const stdout = await gh([
      "api",
      "--method",
      "POST",
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      "--input",
      request,
    ]);
    const posted = obj(parseJson(stdout, "gh api POST review"), "gh api POST review");
    return { id: int(posted.id, "review id"), html_url: str(posted.html_url, "review html_url") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface SummaryReview {
  id: number;
  node_id: string;
  body: string;
  html_url: string;
}

/** The newest review this tool posted, so a later run can replace its body instead of leaving a stale one. */
export async function summaryReview(gh: Gh, pr: PullRequest): Promise<SummaryReview | undefined> {
  const stdout = await gh([
    "api",
    "--paginate",
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
    "--jq",
    ".[] | select((.body // \"\") | contains(\"review_pr:summary\")) | {id, node_id, body, html_url}",
  ]);
  const reviews = stdout
    .split("\n")
    .filter(Boolean)
    .map((line): SummaryReview => {
      const review = obj(parseJson(line, "review"), "review");
      const nodeId = str(review.node_id, "review node_id");
      if (nodeId === "") throw new Error("review node_id: expected a non-empty string");
      return {
        id: int(review.id, "review id"),
        node_id: nodeId,
        body: str(review.body, "review body"),
        html_url: str(review.html_url, "review html_url"),
      };
    });
  return reviews.at(-1);
}

/** Replaces the body of a review this tool already submitted. */
export async function updateReviewBody(gh: Gh, nodeId: string, body: string): Promise<void> {
  await gh([
    "api",
    "graphql",
    "-f",
    "query=mutation($id:ID!, $body:String!) { updatePullRequestReview(input:{pullRequestReviewId:$id, body:$body}) { pullRequestReview { id } } }",
    "-f",
    `id=${nodeId}`,
    "-f",
    `body=${body}`,
  ]);
}

// gh api --paginate needs the $endCursor variable and pageInfo on the connection.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes { id isResolved comments(first: 1) { nodes { body originalCommit { oid } } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Every review thread of the PR, with the commit its first comment was left on. */
export async function openThreads(gh: Gh, pr: PullRequest): Promise<PostedThread[]> {
  const stdout = await gh([
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
  const threads: PostedThread[] = [];
  for (const [pageAt, page] of parsePaginatedPages(stdout).entries()) {
    const where = `review threads page ${pageAt}`;
    const data = obj(obj(page, where).data, `${where}.data`);
    const connection = obj(
      obj(obj(data.repository, `${where}.repository`).pullRequest, `${where}.pullRequest`).reviewThreads,
      `${where}.reviewThreads`,
    );
    for (const [at, node] of arr(connection.nodes, `${where}.nodes`).entries()) {
      const thread = obj(node, `${where}.nodes[${at}]`);
      const first = arr(obj(thread.comments, `${where}.nodes[${at}].comments`).nodes, `${where}.nodes[${at}].comments.nodes`)[0];
      if (first === undefined) continue;
      const comment = obj(first, `${where}.nodes[${at}].comment`);
      const commit = comment.originalCommit === null || comment.originalCommit === undefined
        ? undefined
        : str(obj(comment.originalCommit, `${where}.nodes[${at}].originalCommit`).oid, `${where}.nodes[${at}].originalCommit.oid`);
      if (commit === undefined) continue;
      threads.push({
        id: str(thread.id, `${where}.nodes[${at}].id`),
        body: str(comment.body, `${where}.nodes[${at}].body`),
        commitSha: commit,
        resolved: bool(thread.isResolved, `${where}.nodes[${at}].isResolved`),
      });
    }
  }
  return threads;
}

/** Marks one review thread resolved. */
export async function resolveThread(gh: Gh, threadId: string): Promise<void> {
  await gh([
    "api",
    "graphql",
    "-f",
    "query=mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }",
    "-f",
    `id=${threadId}`,
  ]);
}
