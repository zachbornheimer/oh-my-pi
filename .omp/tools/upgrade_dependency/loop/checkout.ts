import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { obj, parseJson, sha } from "./decode.js";
import { command, type Runner } from "./exec.js";
import { parsePullRequestUrl } from "./parse_url.js";

/** This tool's own checkout tree under the cache directory. */
const CHECKOUT_DIRECTORY = "upgrade-dependency";

/**
 * Where private pull-request checkouts live: `~/Library/Caches/upgrade-dependency` on macOS, else `$XDG_CACHE_HOME` or
 * `~/.cache` plus `upgrade-dependency`. It is this tool's own tree: a `make_pr_mergable` run keeps its checkouts in
 * its own directory and is never reset by this one. (The spend ledger is the one thing shared, on purpose.)
 */
export function checkoutRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library/Caches", CHECKOUT_DIRECTORY);
  const base = env.XDG_CACHE_HOME?.trim();
  return join(base ? base : join(home, ".cache"), CHECKOUT_DIRECTORY);
}

/**
 * A private checkout for one pull request. Never the process's own directory. `__` cannot occur in an owner name, so
 * `a-b/c#1` and `a/b-c#1` get different directories.
 */
export function checkoutDir(root: string, prUrl: string): string {
  const { owner, repo, number } = parsePullRequestUrl(prUrl);
  return join(root, `${owner}__${repo}__${number}`);
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
