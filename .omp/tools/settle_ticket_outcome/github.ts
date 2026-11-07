import type { Exec } from "./omp_session.js";
import { reqObject, reqString } from "./shape.js";

const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const GH_TIMEOUT_MS = 60_000;

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequestRead {
  url: string;
  state: PullRequestState;
}

export interface GitHubPort {
  /** The pull request's URL and state, as GitHub says them now. */
  readPullRequest(url: string): Promise<PullRequestRead>;
  /** Closes the pull request with `comment` as the reason. */
  closePullRequest(input: { url: string; comment: string }): Promise<void>;
}

/** The owner, repository, number and canonical URL of a pull request URL (a `/files` or `#comment` tail is dropped); throws when it is not one. */
export function parsePullUrl(url: string): { org: string; repo: string; number: number; url: string } {
  const match = PULL_URL.exec(url.trim());
  if (match === null) throw new Error(`not a pull request URL: ${url}`);
  return { org: match[1]!, repo: match[2]!, number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

/** Pull requests through `gh`, run by `exec`. */
export function githubPort(exec: Exec, options: { signal?: AbortSignal; cwd?: string } = {}): GitHubPort {
  const gh = async (args: string[]): Promise<string> => {
    const result = await exec("gh", args, { signal: options.signal, timeout: GH_TIMEOUT_MS, cwd: options.cwd });
    if (result.killed) {
      options.signal?.throwIfAborted();
      throw new Error(`gh ${args.slice(0, 2).join(" ")} was stopped after ${GH_TIMEOUT_MS / 1000} s`);
    }
    if (result.code !== 0) {
      throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 400)}`);
    }
    return result.stdout;
  };
  return {
    async readPullRequest(url) {
      parsePullUrl(url);
      const stdout = await gh(["pr", "view", url, "--json", "url,state"]);
      let view: Record<string, unknown>;
      try {
        view = reqObject(JSON.parse(stdout), "gh pr view");
      } catch (error) {
        throw new Error(`gh pr view answered no JSON object for ${url}: ${(error as Error).message}`);
      }
      const state = reqString(view, "state");
      if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") throw new Error(`gh pr view answered state "${state}" for ${url}`);
      return { url: reqString(view, "url"), state };
    },
    async closePullRequest(input) {
      parsePullUrl(input.url);
      await gh(["pr", "close", input.url, "--comment", input.comment]);
    },
  };
}
