import { command, type Exec } from "./exec.js";
import type { GitHubPort } from "./types.js";
import { assertKnownOrg } from "./workspaces.js";

const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** `{ owner, repo, number }` of a `https://github.com/<owner>/<repo>/pull/<n>` URL; throws on anything else. */
export function parsePullRequestUrl(url: string): { owner: string; repo: string; number: number } {
  const where = PULL_URL.exec(url);
  if (where === null) throw new Error(`not a pull request URL: ${url}`);
  return { owner: where[1]!, repo: where[2]!, number: Number(where[3]) };
}

const STATES = ["OPEN", "CLOSED", "MERGED"] as const;

/** Pull requests through `gh`. A close is refused for an organisation no workspace owns. */
export function githubPort(exec: Exec, signal?: AbortSignal): GitHubPort {
  return {
    async readPullRequest(url) {
      const where = parsePullRequestUrl(url);
      const view = JSON.parse(
        await command(exec, "gh", ["pr", "view", url, "--json", "number,url,state,isDraft,headRefName,baseRefName"], { signal }),
      ) as Record<string, unknown>;
      const { number, state, isDraft, headRefName, baseRefName } = view;
      if (
        typeof number !== "number" || typeof view.url !== "string" || !STATES.includes(state as never) || typeof isDraft !== "boolean"
        || typeof headRefName !== "string" || typeof baseRefName !== "string"
      ) {
        throw new Error(`gh pr view ${url} answered an unexpected shape: ${JSON.stringify(view).slice(0, 200)}`);
      }
      return {
        url: view.url,
        org: where.owner,
        repo: where.repo,
        number,
        state: state as (typeof STATES)[number],
        isDraft,
        headRef: headRefName,
        baseRef: baseRefName,
      };
    },
    async closePullRequest(input) {
      const where = parsePullRequestUrl(input.url);
      assertKnownOrg(where.owner);
      await command(exec, "gh", ["pr", "close", input.url, "--comment", input.comment], { signal });
    },
  };
}
