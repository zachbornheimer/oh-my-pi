import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { obj, parseJson, sha } from "./decode.js";
import { command, type Runner } from "./exec.js";
import { parsePullRequestUrl } from "./parse_url.js";

/**
 * Where private pull-request checkouts live: `~/Library/Caches/make-pr-mergable` on macOS (the directory the Mastra
 * twin and `make_pr_mergable` use, so a clone is shared), else `$XDG_CACHE_HOME` or `~/.cache` plus `make-pr-mergable`.
 */
export function checkoutRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library/Caches/make-pr-mergable");
  const base = env.XDG_CACHE_HOME?.trim();
  return join(base ? base : join(home, ".cache"), "make-pr-mergable");
}

/** A private checkout for one pull request. Never the process's own directory. */
export function checkoutDir(root: string, prUrl: string): string {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  return join(root, `${owner}-${repo}-${number}`);
}

/** Operations a crashed worker leaves half done; each has an `--abort`. */
const ABORTABLE_OPERATIONS = ["merge", "rebase", "cherry-pick"] as const;

/**
 * Clone or update the pull request head, always to a clean tree. Uses `gh repo clone` and `refs/pull/N/head`, so a
 * fork or a private repository still lands on the head commit. An existing directory is reused, never an error, and
 * whatever the last round left in it is discarded first: an unfinished merge, rebase or cherry-pick, staged or
 * unmerged files, untracked and ignored files, and the push URL an earlier run set. Throws unless `HEAD` is the
 * head commit and the tree is clean.
 */
export async function pullRequestCheckout(run: Runner, root: string, prUrl: string): Promise<string> {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  const dir = checkoutDir(root, prUrl);
  const view = obj(
    parseJson(await command(run, "gh", ["pr", "view", prUrl, "--json", "headRefOid"]), "gh pr view headRefOid"),
    "gh pr view headRefOid",
  );
  const head = sha(view.headRefOid, "headRefOid");
  await mkdir(root, { recursive: true });
  if (!(await exists(dir))) {
    await command(run, "gh", ["repo", "clone", `${owner}/${repo}`, dir, "--", "--filter=blob:none", "--no-checkout"]);
  }
  const git = (...args: string[]) => command(run, "git", ["-C", dir, ...args]);
  for (const operation of ABORTABLE_OPERATIONS) await git(operation, "--abort").catch(() => undefined);
  await git("config", "--unset-all", "remote.origin.pushurl").catch(() => undefined);
  await git("fetch", "--no-tags", "origin", `refs/pull/${number}/head`);
  await git("checkout", "--detach", "--force", head);
  await git("reset", "--hard", head);
  await git("clean", "-ffdx");
  const got = (await git("rev-parse", "HEAD")).trim();
  if (got.toLowerCase() !== head.toLowerCase()) {
    throw new Error(`checkout is ${got}, pull request head is ${head}`);
  }
  const left = (await git("status", "--porcelain")).trim();
  if (left !== "") throw new Error(`checkout ${dir} is not clean after the reset:\n${left}`);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
