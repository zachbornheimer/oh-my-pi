import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Checkout, type RepoPort, RepositoryUnavailableError } from "./ports.js";
import { checkoutRootFor, soleOrg, type Workspace } from "./workspaces.js";

/** Runs `git -C <cwd> <args>`, answers stdout, throws with stderr on a non-zero exit. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>;

export type RepoPortOptions = {
  git: Git;
  /** Clones `org/repo` into `destination`; throws what `gh repo clone` said (the port reads it for an unavailable repository). */
  clone: (repo: { org: string; name: string }, destination: string) => Promise<void>;
};

/** The organisation and repository a checkout's `origin` names, whatever the organisation is. */
const ORIGIN_REPO = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/**
 * What `gh` says when the repository is not there for this account, rather than a fault worth stopping a run for: the
 * live ZYS run of 2026-10-29 answered `GraphQL: Could not resolve to a Repository with the name '…'. (repository)`.
 */
const REPOSITORY_NOT_FOUND = /could not resolve to a repository|repository not found|http 404/i;

/** Everything a thrown child-process failure says: its message and, when it carries one, its stderr. */
function failureDetail(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (typeof failure === "object" && failure !== null && "stderr" in failure && typeof failure.stderr === "string") {
    return `${failure.stderr} ${message}`.trim();
  }
  return message;
}

/** The line of a failure that says why: a `Command failed: …` header names the invocation, not the fault. */
function reasonLine(detail: string): string {
  const lines = detail.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.find((line) => !line.startsWith("Command failed:")) ?? lines[0] ?? detail;
}

/** `failure` as the port's error when GitHub said the repository is not there for this account; otherwise `failure` itself. */
export function asRepositoryUnavailable(repository: string, failure: unknown): Error {
  const detail = failureDetail(failure);
  if (REPOSITORY_NOT_FOUND.test(detail)) return new RepositoryUnavailableError(repository, reasonLine(detail).slice(0, 400));
  return failure instanceof Error ? failure : new Error(String(failure));
}

/** Local checkouts, worktrees and pushes through `git` and a clone function. */
export function repoPort(options: RepoPortOptions): RepoPort {
  const { git } = options;

  async function succeeds(args: readonly string[], cwd: string): Promise<boolean> {
    return git(args, cwd).then(() => true, () => false);
  }

  /** The checkouts of one directory, by GitHub name: every directory that is a git repository of a GitHub origin. */
  async function checkoutsUnder(root: string): Promise<Checkout[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      // A root this machine does not have holds no checkout; any other failure is a real one.
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const found = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const path = join(root, entry.name);
          if (!(await exists(join(path, ".git")))) return undefined;
          const origin = await git(["remote", "get-url", "origin"], path).catch(() => "");
          const where = ORIGIN_REPO.exec(origin.trim());
          return where === null ? undefined : { org: where[1]!, repo: where[2]!, path };
        }),
    );
    return found.filter((checkout): checkout is Checkout => checkout !== undefined);
  }

  async function listCheckouts(workspace: Workspace): Promise<Checkout[]> {
    const found = (await Promise.all(workspace.roots.map(checkoutsUnder))).flat();
    // A directory named like its repository wins over a scratch copy (`zyins.tmp`) of the same origin.
    return found.sort(
      (a, b) => Number(basename(b.path) === b.repo) - Number(basename(a.path) === a.repo) || a.path.localeCompare(b.path),
    );
  }

  async function defaultBranch(checkout: string): Promise<string> {
    const read = async () => (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], checkout)).trim();
    const ref = await read().catch(async () => {
      await git(["remote", "set-head", "origin", "--auto"], checkout);
      return read();
    });
    return ref.replace(/^origin\//, "");
  }

  /**
   * Fetches the checkout's origin, answering a repository GitHub no longer has as `RepositoryUnavailableError`.
   *
   * The refspec is explicit because the clone's own may be narrow: `git clone --single-branch` (and any clone whose
   * `remote.origin.fetch` holds one head) fetches only the default branch, so a linked pull request's head and the base
   * it was opened against are never local and `git worktree add … origin/<base>` dies `invalid reference` (the ZYS-1872
   * dispatch). Every head is fetched here, whatever the checkout's configuration carries.
   */
  async function fetchOrigin(checkout: string): Promise<void> {
    try {
      await git(["fetch", "origin", "--prune", "+refs/heads/*:refs/remotes/origin/*"], checkout);
    } catch (error) {
      // The checkout's path names no repository GitHub can use, so the error carries the origin's `<org>/<repo>` instead.
      const origin = await git(["remote", "get-url", "origin"], checkout).catch(() => "");
      const where = ORIGIN_REPO.exec(origin.trim());
      throw asRepositoryUnavailable(where === null ? checkout : `${where[1]}/${where[2]}`, error);
    }
  }

  return {
    listCheckouts,
    async ensureCheckout(workspace, repo) {
      const existing = (await listCheckouts(workspace)).find(
        (checkout) => checkout.repo === repo.name && (repo.org === undefined || checkout.org === repo.org),
      );
      if (existing !== undefined) return existing;
      const org = repo.org ?? soleOrg(workspace);
      const destination = join(checkoutRootFor(workspace, org), repo.name);
      await mkdir(dirname(destination), { recursive: true });
      await options.clone({ org, name: repo.name }, destination);
      return { org, repo: repo.name, path: destination };
    },
    async openWorktree({ checkout, ticket, branch, base }) {
      // One worktrees directory per checkout root, beside the checkouts it serves: `~/Developer/Personal/.worktrees/`.
      const worktreesRoot = join(dirname(checkout), ".worktrees");
      const path = join(worktreesRoot, `${basename(checkout)}-${ticket.toLowerCase()}`);
      await fetchOrigin(checkout);
      const baseBranch = base ?? await defaultBranch(checkout);
      if (await exists(join(path, ".git"))) {
        const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path)).trim();
        if (current !== branch) throw new Error(`worktree ${path} is on ${current}, not on ${branch}`);
        return { path, branch, base: baseBranch };
      }
      await mkdir(worktreesRoot, { recursive: true });
      if (await succeeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], checkout)) {
        await git(["worktree", "add", path, branch], checkout);
      } else if (await succeeds(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], checkout)) {
        await git(["worktree", "add", "-b", branch, path, `origin/${branch}`], checkout);
      } else if (await succeeds(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], checkout)) {
        await git(["worktree", "add", "-b", branch, path, `origin/${baseBranch}`], checkout);
      } else {
        // Every head was fetched above, so a base that is not there is a branch the remote does not have: naming both
        // branches and the checkout beats the `invalid reference` git answers for a ref it cannot resolve.
        throw new Error(
          `${checkout}: origin has no branch ${baseBranch} (and none named ${branch}) to start the worktree from`,
        );
      }
      return { path, branch, base: baseBranch };
    },
    worktreeExists: (path) => exists(join(path, ".git")),
    async commitLeftovers({ worktree, message }) {
      if ((await git(["status", "--porcelain", "--untracked-files=all"], worktree)).trim() === "") return false;
      await git(["add", "-A"], worktree);
      await git(["commit", "-m", message], worktree);
      return true;
    },
    async commitsAhead({ worktree, base }) {
      return Number((await git(["rev-list", "--count", `origin/${base}..HEAD`], worktree)).trim());
    },
    async push({ worktree, branch }) {
      await git(["push", "-u", "origin", `${branch}:${branch}`], worktree);
    },
  };
}
