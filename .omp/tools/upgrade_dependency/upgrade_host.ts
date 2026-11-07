import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PackagesFromBody, PackagesFromTitle } from "./lib/body.js";
import { parsePullFiles } from "./lib/github.js";
import type { ProcessResult } from "./lib/host_machine.js";
import { type ChangedFile, ParsePRURL } from "./lib/load.js";
import type { Command, Process } from "./lib/ports.js";
import { NPMPeers, unitNames, units } from "./lib/units.js";
import { ISSUE_BODY_CAP, PUSH_HOOK_BUDGET_MS, PUSH_VISIBLE_BUDGET_MS, SETTLE_POLL_MS } from "./loop/constants.js";
import { bool, obj, parseJson, sha, str } from "./loop/decode.js";
import { command, DEFAULT_COMMAND_TIMEOUT_MS, type Runner, sleep, spawnRunner } from "./loop/exec.js";
import { headContains } from "./loop/head_contains.js";
import { pushEnv } from "./loop/omp_round.js";
import { checkoutForPr } from "./loop/run.js";

/**
 * What a pull request's own host does that the loop does not: bring each lockfile of a changed manifest up to date,
 * commit and push the ones the install rewrote, read the head again after a fix round, and arm the merge. One host
 * belongs to one pull request and one run; nothing here is shared between runs.
 */

const DEPENDENCIES_CHECKED = "ai:dependencies-checked";

/** `HostRun`'s code for a program that never completed: not installed, or killed at its timeout. */
const NOT_COMPLETED = -1;

/** One lockfile install or tidy may download a module graph; this long before it is killed. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Each lockfile name: what its install is called, and the command that rewrites only that lockfile in `dir`. */
const LOCKFILE_INSTALLS: Readonly<Record<string, { label: string; argv: (dir: string) => readonly string[] }>> = {
  "aube-lock.yaml": {
    label: "aube install",
    argv: (dir) => ["aube", "-C", dir, "install", "--lockfile-only", "--ignore-scripts"],
  },
  "pnpm-lock.yaml": {
    label: "pnpm install",
    argv: (dir) => ["pnpm", "-C", dir, "install", "--lockfile-only", "--ignore-scripts"],
  },
  "package-lock.json": {
    label: "npm install",
    argv: (dir) => ["npm", "--prefix", dir, "install", "--package-lock-only", "--ignore-scripts"],
  },
  "go.sum": { label: "go mod tidy", argv: (dir) => ["go", "-C", dir, "mod", "tidy"] },
  "mise.lock": { label: "mise lock", argv: (dir) => ["mise", "--cd", dir, "--yes", "lock"] },
};

interface LockfileRule {
  /** The manifest's lockfile names, the first present one wins. */
  readonly names: readonly string[];
  /** Whether a lockfile in a parent directory is the manifest's (a workspace root). */
  readonly climbs: boolean;
  /** Whether the install runs with no lockfile yet, because it may write one (`go mod tidy` writes go.sum). */
  readonly installCreates: boolean;
}

/** The manifests whose lockfile this step can bring up to date, by file name. */
const MANIFEST_LOCKFILES: Readonly<Record<string, LockfileRule>> = {
  "package.json": {
    names: ["aube-lock.yaml", "pnpm-lock.yaml", "package-lock.json"],
    climbs: true,
    installCreates: false,
  },
  "go.mod": { names: ["go.sum"], climbs: false, installCreates: true },
  "mise.toml": { names: ["mise.lock"], climbs: false, installCreates: false },
};

/** Where a lockfile stands after the step looked at the manifest it belongs to. */
export type LockfileStatus =
  | { readonly state: "in_pull_request"; readonly lockfile: string }
  | { readonly state: "rewritten"; readonly lockfile: string; readonly via: string }
  | { readonly state: "unchanged"; readonly lockfile: string; readonly via: string }
  | { readonly state: "stale"; readonly lockfile: string; readonly reason: string }
  | { readonly state: "absent"; readonly manifest: string; readonly lockfiles: readonly string[] }
  | { readonly state: "unsupported"; readonly manifest: string };

/** The lockfile statuses and the working copy commit they were read at. */
export interface LockfileState {
  readonly statuses: readonly LockfileStatus[];
  readonly head: string;
}

/** The upgrade units of a head, one array of package names per unit. */
export type Units = string[][];

export interface UpgradeHost {
  /**
   * The lockfile nearest each changed manifest, brought up to date by its own tool on a clean checkout of the pull
   * request's head, then committed and pushed when the install rewrote it. A lockfile the install left alone is
   * current: the bump touched nothing it locks. One it could not rewrite, or could not push, is `stale`; a manifest
   * whose repo has no lockfile for it is `absent`. `committed` names the lockfiles the pull request itself carries.
   */
  settleLockfiles(manifests: readonly string[], committed: readonly string[]): Promise<LockfileState>;
  /**
   * `settleLockfiles` once someone else has pushed to the branch (a fix round of the pull request loop): the checkout
   * is taken again from GitHub's current head, so a rewritten lockfile is committed on top of what was pushed.
   */
  resettleLockfiles(manifests: readonly string[], committed: readonly string[]): Promise<LockfileState>;
  /**
   * Arm squash automerge, then label the pull request `ai:dependencies-checked` (creating the label when the repo has
   * none). When GitHub refuses automerge (the pull request is already mergeable, or the repo disallows it) the pull
   * request is squash-merged at once, as the Mastra capability did. `armed` is false, with GitHub's reason, when the
   * merge is refused or the label cannot be applied. Run only once the pull request is green.
   */
  armPullRequest(): Promise<{ armed: boolean; reason: string }>;
  /**
   * Files the pull request changes on its current head, with the patch GitHub reports for each. Undefined when GitHub
   * cannot be read, so the caller keeps what it has instead of treating a failed read as an empty diff.
   */
  currentChangedFiles(repo: string, number: number): Promise<ChangedFile[] | undefined>;
  /**
   * The upgrade units of the pull request as its head stands now, re-derived from the body and title it carries.
   * Undefined when the body cannot be read or a package's peers cannot be resolved, so the caller keeps the units it
   * already has rather than judging on a read that failed.
   */
  currentHeadUnits(repo: string, number: number, ecosystem: string): Promise<Units | undefined>;
}

/**
 * Runs one program in `cwd` with `env` added to the environment and reports how it ended. A non-zero exit, a program
 * that is not installed (`code` -1) and a timeout are all results; only a cancelled run throws.
 */
export type HostRun = (
  cwd: string,
  program: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<ProcessResult>;

export interface UpgradeHostOptions {
  readonly prUrl: string;
  /** A clean, detached checkout of the pull request's current head; the same directory on every call is fine. */
  readonly checkout: (prUrl: string) => Promise<string>;
  readonly run: HostRun;
  /** Runs `gh` and returns stdout, throws with `gh`'s message on a non-zero exit. */
  readonly gh: (args: readonly string[]) => Promise<string>;
  /** Whether `path` is a regular file. Default: the file system. */
  readonly isFile?: (path: string) => Promise<boolean>;
  /** Waits `ms`. Default: a timer that rejects when `signal` aborts. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Epoch milliseconds now. Default: the system clock. */
  readonly now?: () => number;
  /** A cancelled run is rethrown where a failed read would otherwise be reported as unreadable. */
  readonly signal?: AbortSignal;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The tail of what a command said, the part that names the failure. */
function said(result: ProcessResult): string {
  return (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(-ISSUE_BODY_CAP);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The login inside a `{ login }` object `gh` reports, or undefined for null, a missing field or another shape. */
function loginOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const login = (value as { login?: unknown }).login;
  return typeof login === "string" && login !== "" ? login : undefined;
}

/** The directory of `lockfile` inside the repository, `.` for the root. */
function directoryOf(lockfile: string): string {
  return lockfile.includes("/") ? lockfile.slice(0, lockfile.lastIndexOf("/")) : ".";
}

type PushTarget = { readonly remote: string; readonly branch: string } | { readonly refusal: string };

/** Creates the host of one pull request. Nothing is shared between hosts. */
export function createUpgradeHost(options: UpgradeHostOptions): UpgradeHost {
  const { prUrl, checkout, run, gh, signal } = options;
  const ref = ParsePRURL(prUrl);
  const number = String(ref.number);
  const repo = `${ref.owner}/${ref.repo}`;
  const isFile = options.isFile ?? isRegularFile;
  const wait = options.sleep ?? ((ms: number) => sleep(ms, signal));
  const now = options.now ?? Date.now;
  /** The working copy the last settle used; `npm view` reads the repository's own registry configuration there. */
  let workingCopy: string | undefined;

  /** A cancelled run is never reported as a failed read or write: it is rethrown. */
  function rethrowIfCancelled(error: unknown): void {
    if (signal?.aborted === true) throw error;
  }

  /** The reason a failed read or write is reported. */
  function reasonOf(error: unknown): string {
    rethrowIfCancelled(error);
    return messageOf(error);
  }

  async function headOf(dir: string): Promise<string> {
    const head = await run(dir, "git", ["rev-parse", "HEAD"]);
    const commit = head.stdout.trim();
    if (head.code !== 0 || commit === "") {
      throw new Error(`could not read the working copy's HEAD: ${said(head) || `git rev-parse exited ${head.code}`}`);
    }
    return commit;
  }

  /**
   * The lockfile a manifest's rule names, in the manifest's directory or above it when the rule climbs. A path the pull
   * request already carries counts as present. A rule that creates its lockfile on install names it where it would go.
   */
  async function lockfileFor(
    dir: string,
    manifest: string,
    rule: LockfileRule,
    committed: readonly string[],
  ): Promise<string | undefined> {
    const parts = manifest.split("/").slice(0, -1);
    for (let depth = parts.length; depth >= (rule.climbs ? 0 : parts.length); depth--) {
      const directory = parts.slice(0, depth).join("/");
      for (const name of rule.names) {
        const path = directory === "" ? name : `${directory}/${name}`;
        if (committed.includes(path) || (await isFile(join(dir, path)))) return path;
      }
    }
    return rule.installCreates ? join(...parts, rule.names[0]!) : undefined;
  }

  /** Whether the viewer may push to the base repository: the permission `gh` reports for the logged-in user. */
  async function viewerCanPushBase(): Promise<boolean> {
    const answer = await gh([
      "api",
      `repos/${repo}`,
      "--jq",
      ".permissions.push == true or .permissions.maintain == true or .permissions.admin == true",
    ]);
    return answer.trim() === "true";
  }

  /**
   * Where a push to the pull request's own head branch goes: `origin` for a branch of the base repository, the fork's
   * URL for a fork the viewer may push to. A closed pull request, a viewer with no push access and a fork the viewer
   * neither owns nor may maintain are refused with the reason, never pushed.
   */
  async function pushTarget(): Promise<PushTarget> {
    const where = "gh pr view";
    const view = obj(
      parseJson(
        await gh([
          "pr",
          "view",
          number,
          "--repo",
          repo,
          "--json",
          "state,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author",
        ]),
        where,
      ),
      where,
    );
    const state = str(view.state, `${where} state`);
    if (state !== "OPEN") return { refusal: `the pull request is ${state.toLowerCase()}` };
    const branch = str(view.headRefName, `${where} headRefName`);
    if (branch === "") return { refusal: "the pull request has no head branch" };
    const canPush = await viewerCanPushBase();
    if (!bool(view.isCrossRepository, `${where} isCrossRepository`)) {
      return canPush ? { remote: "origin", branch } : { refusal: `the viewer has no push access to ${repo}` };
    }
    const author = loginOf(view.author) ?? "ghost";
    const headOwner = loginOf(view.headRepositoryOwner) ?? author;
    const headRepository = view.headRepository === null || view.headRepository === undefined
      ? undefined
      : obj(view.headRepository, `${where} headRepository`);
    const headName = typeof headRepository?.name === "string" && headRepository.name !== ""
      ? headRepository.name
      : ref.repo;
    const headRepo = typeof headRepository?.nameWithOwner === "string" && headRepository.nameWithOwner !== ""
      ? headRepository.nameWithOwner
      : `${headOwner}/${headName}`;
    if (!canPush) {
      const viewer = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (viewer === "" || (author !== viewer && headOwner !== viewer)) {
        return { refusal: `the head branch is on the fork ${headRepo}; this run pushes only to a fork the viewer owns` };
      }
    }
    return { remote: `https://github.com/${headRepo}.git`, branch };
  }

  /**
   * Polls GitHub, every SETTLE_POLL_MS and within PUSH_VISIBLE_BUDGET_MS, until the pull request's head contains
   * `pushed`: a read taken right after a push can still see the old head, and the next settle checks out what GitHub
   * reports. Returns undefined once it does, else what GitHub last reported.
   */
  async function reportedHeadAfter(pushed: string): Promise<string | undefined> {
    const deadline = now() + PUSH_VISIBLE_BUDGET_MS;
    const reportedHead = async (): Promise<string> =>
      sha(
        (await gh(["pr", "view", number, "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim(),
        "gh pr view headRefOid",
      );
    let reported = await reportedHead();
    while (!(await headContains({ gh }, repo, pushed, reported))) {
      if (now() + SETTLE_POLL_MS > deadline) return reported;
      await wait(SETTLE_POLL_MS);
      reported = await reportedHead();
    }
    return undefined;
  }

  /**
   * Commits only `lockfiles` (a conventional `chore(deps)` commit) and pushes it to the pull request's head branch with
   * the repository's pre-push hooks running, no force. Where the push may go is read first: a pull request that
   * cannot be pushed to is refused before anything is committed. Ok only once GitHub reports the pushed commit as the
   * head.
   */
  async function commitAndPush(dir: string, lockfiles: readonly string[]): Promise<{ ok: boolean; reason: string }> {
    let target: PushTarget;
    try {
      target = await pushTarget();
    } catch (error) {
      return { ok: false, reason: `could not read where to push: ${reasonOf(error)}` };
    }
    if ("refusal" in target) return { ok: false, reason: target.refusal };
    const staged = await run(dir, "git", ["add", "--", ...lockfiles]);
    if (staged.code !== 0) return { ok: false, reason: said(staged) || `git add exited ${staged.code}` };
    const committed = await run(dir, "git", ["commit", "-m", `chore(deps): refresh ${lockfiles.join(", ")}`]);
    if (committed.code !== 0) return { ok: false, reason: said(committed) || `git commit exited ${committed.code}` };
    const pushed = await run(dir, "git", ["push", target.remote, `HEAD:refs/heads/${target.branch}`]);
    if (pushed.code !== 0) return { ok: false, reason: said(pushed) || `git push exited ${pushed.code}` };
    const pushedHead = await headOf(dir);
    try {
      const reported = await reportedHeadAfter(pushedHead);
      if (reported !== undefined) {
        return {
          ok: false,
          reason: `could not confirm the push of ${pushedHead}: GitHub still reports the head as ${reported} ${
            PUSH_VISIBLE_BUDGET_MS / 60_000
          } minutes after it`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `could not confirm the push of ${pushedHead}: GitHub's head could not be read: ${reasonOf(error)}`,
      };
    }
    return { ok: true, reason: "" };
  }

  async function refreshLockfiles(
    dir: string,
    manifests: readonly string[],
    committed: readonly string[],
  ): Promise<readonly LockfileStatus[]> {
    const statuses: LockfileStatus[] = [];
    const seen = new Set<string>();
    for (const manifest of manifests) {
      const rule = MANIFEST_LOCKFILES[basename(manifest)];
      if (rule === undefined) {
        statuses.push({ state: "unsupported", manifest });
        continue;
      }
      const lockfile = await lockfileFor(dir, manifest, rule, committed);
      if (lockfile === undefined) {
        statuses.push({ state: "absent", manifest, lockfiles: rule.names });
        continue;
      }
      if (seen.has(lockfile)) continue;
      seen.add(lockfile);
      if (committed.includes(lockfile)) {
        statuses.push({ state: "in_pull_request", lockfile });
        continue;
      }
      const install = LOCKFILE_INSTALLS[basename(lockfile)]!;
      const [program, ...args] = install.argv(join(dir, directoryOf(lockfile)));
      const ran = await run(dir, program!, args, { CI: "true" });
      if (ran.code !== 0) {
        const reason = said(ran);
        statuses.push({ state: "stale", lockfile, reason: reason === "" ? `${install.label} failed` : reason });
      } else if (!(await isFile(join(dir, lockfile)))) {
        statuses.push({ state: "absent", manifest, lockfiles: rule.names });
      } else {
        const status = await run(dir, "git", ["status", "--porcelain", "--", lockfile]);
        if (status.code !== 0) {
          statuses.push({
            state: "stale",
            lockfile,
            reason: `could not tell whether ${install.label} changed it: ${said(status) || `git status exited ${status.code}`}`,
          });
        } else {
          statuses.push(
            status.stdout.trim() === ""
              ? { state: "unchanged", lockfile, via: install.label }
              : { state: "rewritten", lockfile, via: install.label },
          );
        }
      }
    }
    const rewritten = statuses.flatMap((status) => (status.state === "rewritten" ? [status.lockfile] : []));
    if (rewritten.length === 0) return statuses;
    const pushed = await commitAndPush(dir, rewritten);
    if (pushed.ok) return statuses;
    return statuses.map((status): LockfileStatus =>
      status.state === "rewritten"
        ? { state: "stale", lockfile: status.lockfile, reason: `rewritten but not pushed: ${pushed.reason}` }
        : status
    );
  }

  /** The checkout is the pull request's head as GitHub reports it now, so one routine serves both entry points. */
  async function settle(manifests: readonly string[], committed: readonly string[]): Promise<LockfileState> {
    const dir = await checkout(ref.url);
    workingCopy = dir;
    const statuses = await refreshLockfiles(dir, manifests, committed);
    return { statuses, head: await headOf(dir) };
  }

  /** `run` as the `Process` the peer lookup runs through, in the working copy. */
  function processIn(dir: string): Process {
    return {
      run: async (spec: Command): Promise<ProcessResult> => run(spec.dir ?? dir, spec.command, spec.args),
      lookPath: async (file: string): Promise<string> => {
        const found = await run(dir, "which", [file]);
        if (found.code !== 0 || found.stdout.trim() === "") throw new Error(`depupgrade: ${file} is not on PATH`);
        return found.stdout.trim();
      },
    };
  }

  async function tagDependenciesChecked(): Promise<{ ok: boolean; reason: string }> {
    try {
      await gh([
        "label",
        "create",
        DEPENDENCIES_CHECKED,
        "--repo",
        repo,
        "--description",
        "Dependency upgrade checked by upgrade_dependency",
        "--color",
        "0E8A16",
        "--force",
      ]);
      await gh(["pr", "edit", number, "--repo", repo, "--add-label", DEPENDENCIES_CHECKED]);
      return { ok: true, reason: "" };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  return {
    settleLockfiles: settle,
    resettleLockfiles: settle,

    async armPullRequest() {
      let merged: string;
      try {
        merged = await gh(["pr", "merge", number, "--repo", repo, "--auto", "--squash"]);
      } catch (autoError) {
        const autoReason = reasonOf(autoError);
        try {
          merged = await gh(["pr", "merge", number, "--repo", repo, "--squash"]);
        } catch (error) {
          return { armed: false, reason: reasonOf(error) || autoReason };
        }
      }
      const tagged = await tagDependenciesChecked();
      if (!tagged.ok) return { armed: false, reason: tagged.reason };
      return { armed: true, reason: merged.trim() };
    },

    async currentChangedFiles(changedRepo, changedNumber) {
      try {
        const listed = (await gh(["api", `repos/${changedRepo}/pulls/${changedNumber}/files`, "--paginate"])).trim();
        // `parsePullFiles` reads output with no complete JSON array in it as no files; an answer that is not a list of
        // pages is unreadable, not an empty diff.
        return listed.startsWith("[") && listed.endsWith("]") ? parsePullFiles(listed) : undefined;
      } catch (error) {
        rethrowIfCancelled(error);
        return undefined;
      }
    },

    async currentHeadUnits(unitsRepo, unitsNumber, ecosystem) {
      let title: string;
      let body: string;
      try {
        const shown = await gh(["pr", "view", String(unitsNumber), "--repo", unitsRepo, "--json", "title,body"]);
        const decoded = JSON.parse(shown) as { body?: unknown; title?: unknown };
        body = typeof decoded.body === "string" ? decoded.body : "";
        title = typeof decoded.title === "string" ? decoded.title : "";
      } catch (error) {
        rethrowIfCancelled(error);
        return undefined;
      }
      const fromBody = PackagesFromBody(body);
      const packages = fromBody.length > 0 ? fromBody : PackagesFromTitle(title);
      if (packages.length === 0) return undefined;
      const gaps: string[] = [];
      if (workingCopy === undefined) workingCopy = await checkout(ref.url);
      const dir = workingCopy;
      const unitList = await units(new NPMPeers(processIn(dir)), ecosystem, packages, (message) => {
        gaps.push(message);
      });
      if (gaps.length > 0) return undefined;
      return unitNames(unitList);
    },
  };
}

/**
 * `run` over a real `Runner`. A `git push` runs with the repository's pre-push hooks, the `gh` login's token in the
 * environment (`pushEnv`) and the hook budget; everything else gets `INSTALL_TIMEOUT_MS`. A program that is not
 * installed, or that timed out, is a result with code -1 and what happened in `stderr`, so a missing tool reads as a
 * stale lockfile, never as a current one. A cancelled run throws.
 */
export function runThrough(runner: Runner, signal?: AbortSignal): HostRun {
  return async (cwd, program, args, env) => {
    const pushing = program === "git" && args[0] === "push";
    const base = pushing ? await pushEnv(runner) : process.env;
    const timeoutMs = pushing ? PUSH_HOOK_BUDGET_MS : INSTALL_TIMEOUT_MS;
    let result;
    try {
      result = await runner(program, args, {
        cwd,
        env: env === undefined ? base : { ...base, ...env },
        timeoutMs,
        signal,
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return { code: NOT_COMPLETED, stdout: "", stderr: messageOf(error) };
    }
    if (result.killed) {
      if (signal?.aborted === true) throw new Error(`${program} was cancelled`);
      return {
        code: NOT_COMPLETED,
        stdout: result.stdout,
        stderr: `${result.stderr}\n${program} timed out after ${timeoutMs} ms`.trim(),
      };
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

/** The host of `prUrl` on this machine: the real `gh`, `git` and package tools, and a private checkout of the head. */
export function liveUpgradeHost(prUrl: string, signal?: AbortSignal): UpgradeHost {
  const runner = spawnRunner({ signal });
  return createUpgradeHost({
    prUrl,
    signal,
    checkout: checkoutForPr({ signal }),
    run: runThrough(runner, signal),
    gh: (args) => command(runner, "gh", args, { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }),
  });
}
