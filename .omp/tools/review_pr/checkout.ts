import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, type Runner } from "./exec.js";
import type { PullRequest } from "./types.js";

/** A throwaway clone checked out at the PR's pinned head, with the base branch fetched for diff baselines. */
export interface Checkout {
  /** The clone's working tree, at `pr.headSha`. */
  readonly directory: string;
  /** The fetched base branch, for `--baseline-commit` and `--from`. */
  readonly baseRef: string;
}

const BASE = "refs/remotes/origin/review-base";
const HEAD = "refs/remotes/origin/review-head";
/** Cloning a large repository is the slow step. */
const CLONE_TIMEOUT_MS = 20 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Clones the PR into a private temporary directory and checks out exactly `pr.headSha`, so a reviewer reads the pinned
 * snapshot. Throws when the PR moved between reading it and cloning it; the caller retries from a new snapshot. The
 * directory is removed afterwards, success or not.
 */
export async function withCheckout<T>(
  run: Runner,
  pr: PullRequest,
  fn: (checkout: Checkout) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "review-pr-"));
  try {
    await command(run, "gh", ["repo", "clone", `${pr.owner}/${pr.repo}`, directory, "--", "--no-checkout"], {
      signal,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    const git = (args: string[]): Promise<string> =>
      command(run, "git", ["-C", directory, ...args], { signal, timeoutMs: GIT_TIMEOUT_MS });
    await git(["fetch", "--no-tags", "origin", `refs/heads/${pr.baseRef}:${BASE}`, `refs/pull/${pr.number}/head:${HEAD}`]);
    const [baseSha, headSha] = await Promise.all([git(["rev-parse", BASE]), git(["rev-parse", HEAD])]);
    if (baseSha.trim() !== pr.baseSha || headSha.trim() !== pr.headSha) {
      throw new Error("Pull request changed while preparing its review; retry from a new snapshot");
    }
    await git(["checkout", "--detach", "--quiet", HEAD]);
    return await fn({ directory, baseRef: BASE });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
