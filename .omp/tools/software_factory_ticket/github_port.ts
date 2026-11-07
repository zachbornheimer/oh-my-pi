import type { GitHubPort } from "./ports.js";
import { PULL_REQUEST_STATES, type PullRequest } from "./schemas.js";
import { assertKnownOrg } from "./workspaces.js";

const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export type Gh = (args: readonly string[]) => Promise<string>;

type View = { number: number; url: string; state: PullRequest["state"]; isDraft: boolean; headRefName: string; baseRefName: string };

function viewOf(value: unknown, what: string): View {
  const view = value as Partial<View> | null;
  if (
    typeof view !== "object" || view === null
    || typeof view.number !== "number" || typeof view.url !== "string"
    || typeof view.state !== "string" || !(PULL_REQUEST_STATES as readonly string[]).includes(view.state)
    || typeof view.isDraft !== "boolean" || typeof view.headRefName !== "string" || typeof view.baseRefName !== "string"
  ) {
    throw new Error(`gh answered an unexpected shape for ${what}`);
  }
  return view as View;
}

function pullRequestOf(view: View, where: RegExpExecArray): PullRequest {
  return {
    url: view.url,
    org: where[1]!,
    repo: where[2]!,
    number: view.number,
    state: view.state,
    isDraft: view.isDraft,
    headRef: view.headRefName,
    baseRef: view.baseRefName,
  };
}

const VIEW_FIELDS = "number,url,state,isDraft,headRefName,baseRefName";

/** Pull requests through `gh`; `gh` is the real binary unless a test supplies one. */
export function githubPort(gh: Gh): GitHubPort {
  return {
    async readPullRequest(url) {
      const where = PULL_URL.exec(url);
      if (where === null) throw new Error(`not a pull request URL: ${url}`);
      return pullRequestOf(viewOf(JSON.parse(await gh(["pr", "view", url, "--json", VIEW_FIELDS])), url), where);
    },
    async readPullRequestAuthor(url) {
      if (!PULL_URL.test(url)) throw new Error(`not a pull request URL: ${url}`);
      const view = JSON.parse(await gh(["pr", "view", url, "--json", "author"])) as { author?: { login?: unknown } | null };
      const login = view.author?.login;
      return typeof login === "string" ? login : "";
    },
    async createPullRequest(input) {
      assertKnownOrg(input.org);
      const stdout = await gh([
        "pr",
        "create",
        "--repo",
        `${input.org}/${input.repo}`,
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
        ...(input.draft ? ["--draft"] : []),
      ]);
      const url = stdout.trim().split("\n").at(-1) ?? "";
      if (!PULL_URL.test(url)) throw new Error(`gh pr create answered no pull request URL: ${stdout.slice(0, 400)}`);
      return url;
    },
    async markPullRequestReady(url) {
      const where = PULL_URL.exec(url);
      if (where === null) throw new Error(`not a pull request URL: ${url}`);
      assertKnownOrg(where[1]!);
      await gh(["pr", "ready", url]);
    },
    async closePullRequest(input) {
      const where = PULL_URL.exec(input.url);
      if (where === null) throw new Error(`not a pull request URL: ${input.url}`);
      assertKnownOrg(where[1]!);
      await gh(["pr", "close", input.url, "--comment", input.comment]);
    },
  };
}
