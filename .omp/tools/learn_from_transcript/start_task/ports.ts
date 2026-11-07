import { readFile, stat } from "node:fs/promises";
import {
  AtaskError,
  ataskEnvelope,
  CLAIM_TIMEOUT_MS,
  type RunAtask,
  runAtask,
  runClaim,
} from "./atask_cli.js";
import { projectsFromList, type ProjectsSource, resolveProject } from "./projects.js";
import { outputOf, type RunProgram, runProgram } from "./programs.js";
import { tailOf } from "./text.js";

/**
 * The ports the start_atask_task lifecycle reads: the atask CLI it shows, claims, renews and
 * verifies the objective through, and the landed-work programs — wt, git, gh — each argv-only.
 * The live wiring sits at the bottom of this file; tests script fakes and drive the lifecycle
 * directly, so no test spawns a worker or runs wt.
 */

/** Milliseconds `atask verify complete` may run: it executes the task's whole check suite. */
export const VERIFY_TIMEOUT_MS = 20 * 60_000;
/** `wt merge` rebases and fast-forwards; give it room. */
const WT_TIMEOUT_MS = 280_000;
/** A push, a pull-request open, or an auto-merge arm. */
const GITHUB_TIMEOUT_MS = 120_000;
/** A local git read such as `merge-base`. */
const GIT_TIMEOUT_MS = 30_000;

/** The claim's worktree facts a started run reads. */
export interface TaskAttempt {
  readonly workspace?: string;
  readonly branch?: string;
  /** The claim token, when atask reports one, so a reattached run can renew the lease. */
  readonly token?: string;
  /** The lease expiry in epoch milliseconds, parsed from atask's ISO string. */
  readonly lease_expires_ms?: number;
  readonly lease_active?: boolean;
}

/** A task's state as `atask show <id> --json` reports the parts this tool reads. */
export interface TaskSnapshot {
  readonly id: string;
  readonly status: string;
  readonly title?: string;
  /** The task's project name, where a landing reads its target branch from. */
  readonly project?: string;
  /** The verification summary atask recorded, when its engine has verified the task. */
  readonly verdict?: string;
  /**
   * The revision atask recorded when the task completed. The landing's evidence when the worktree
   * is gone: wt removed the branch with it, but the revision it verified still names the work.
   */
  readonly completedRevision?: string;
  /** A checkout of the task's project that outlives the task worktree: where the landing's containment check runs. */
  readonly createdCwd?: string;
  readonly attempt?: TaskAttempt;
}

/** What claiming the objective returns: the token that owns the claim, and the worktree atask made. */
export interface ClaimedTask {
  readonly token: string;
  readonly workspace: string;
  readonly branch: string;
  /** The project's target branch a completed attempt lands on. */
  readonly target_branch?: string;
}

/** The atask calls starting one objective needs. Failures throw `AtaskError`, never silently. */
export interface StartTaskAtaskPort {
  /** The task's current state, with the claim's attempt when one is live. */
  show(id: string): Promise<TaskSnapshot>;
  /** Claims the task; atask creates or reuses the task worktree and stores the token in it. */
  claim(id: string): Promise<ClaimedTask>;
  /**
   * Claims no named task. `atask claim` assigns the oldest eligible one, scoped to `project` when set.
   * The id is the task atask assigned, not one the caller chose.
   */
  assign(project?: string): Promise<ClaimedTask & { readonly id: string }>;
  /** Extends the claim's lease. */
  renew(token: string): Promise<void>;
  /** Runs `atask verify complete` in the task worktree; throws when verification does not pass. */
  verifyComplete(workspace: string): Promise<void>;
  /** The project's atask target branch; undefined when the project names none. Never throws. */
  projectTarget(project: string): Promise<string | undefined>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const optString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The lease expiry as epoch milliseconds, when atask reports one this call can parse. */
function leaseMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The task the `show` envelope carries; throws an OUTPUT `AtaskError` when it is not one. */
export function snapshotFromShow(envelope: { readonly result?: unknown }): TaskSnapshot {
  const result = envelope.result;
  if (!isObject(result) || typeof result.id !== "string" || typeof result.status !== "string") {
    throw new AtaskError("show", "OUTPUT", "atask show did not return the task: result lacks a string id and status");
  }
  const verification = isObject(result.verification) ? result.verification : undefined;
  const complete = verification !== undefined && isObject(verification.complete) ? verification.complete : undefined;
  const attempt = isObject(result.attempt) ? result.attempt : undefined;
  return {
    id: result.id,
    status: result.status,
    title: optString(result.title),
    project: optString(result.project),
    verdict: optString(complete?.summary),
    completedRevision: optString(result.completed_revision),
    createdCwd: optString(result.created_cwd),
    attempt: attempt === undefined
      ? undefined
      : {
        workspace: optString(attempt.workspace),
        branch: optString(attempt.branch),
        token: optString(attempt.token),
        lease_expires_ms: leaseMs(optString(attempt.lease_expires_at)),
        lease_active: typeof attempt.lease_active === "boolean" ? attempt.lease_active : undefined,
      },
  };
}

/** The claim a `claim` envelope carries (token, workspace, branch must be non-empty). */
function claimFromResult(result: unknown, what: string): { token: string; workspace: string; branch: string; result: Json } {
  const record = isObject(result) ? result : {};
  const token = nonEmpty(record.token);
  const workspace = nonEmpty(record.workspace);
  const branch = nonEmpty(record.branch);
  if (token === undefined || workspace === undefined || branch === undefined) {
    throw new AtaskError("claim", "OUTPUT", `${what}: result lacks a token, workspace and branch`);
  }
  return { token, workspace, branch, result: record };
}

/** The real atask CLI as this tool's port; `claimTimeoutMs` is how long one claim is waited on. */
export function cliStartTaskAtask(
  run: RunAtask = runAtask,
  claimTimeoutMs: number = CLAIM_TIMEOUT_MS,
  signal?: AbortSignal,
): StartTaskAtaskPort {
  const projects: ProjectsSource = async () => {
    const listing = await run(["--json", "projects"], { signal });
    if (listing.spawnError !== undefined) throw new Error(`atask CLI is not runnable: ${listing.spawnError}`);
    return projectsFromList(listing.stdout);
  };
  return {
    async show(id) {
      return snapshotFromShow(ataskEnvelope(await run(["--json", "show", id], { signal }), "show"));
    },
    async claim(id) {
      const envelope = ataskEnvelope(await runClaim(run, ["--json", "claim", id], claimTimeoutMs, signal), "claim");
      const claim = claimFromResult(envelope.result, "atask claim did not return a workspace");
      return {
        token: claim.token,
        workspace: claim.workspace,
        branch: claim.branch,
        target_branch: optString(envelope.target_branch),
      };
    },
    async assign(project) {
      const board = project === undefined ? undefined : await resolveProject(project, projects);
      const argv = board === undefined ? ["--json", "claim"] : ["--json", "--project", board, "claim"];
      const envelope = ataskEnvelope(await runClaim(run, argv, claimTimeoutMs, signal), "claim");
      const claim = claimFromResult(envelope.result, "atask claim assigned no task");
      const task = isObject(claim.result.task) ? claim.result.task : undefined;
      const id = nonEmpty(task?.id);
      if (id === undefined) throw new AtaskError("claim", "OUTPUT", "atask claim assigned no task: result lacks task.id");
      return {
        id,
        token: claim.token,
        workspace: claim.workspace,
        branch: claim.branch,
        target_branch: optString(claim.result.target_branch) ?? optString(envelope.target_branch),
      };
    },
    async renew(token) {
      ataskEnvelope(await run(["--json", "claim", "renew", token], { signal }), "renew");
    },
    async verifyComplete(workspace) {
      ataskEnvelope(
        await run(["--json", "verify", "complete"], { cwd: workspace, timeoutMs: VERIFY_TIMEOUT_MS, signal }),
        "verify complete",
      );
    },
    async projectTarget(project) {
      const board = await resolveProject(project, projects);
      const envelope = ataskEnvelope(await run(["--json", "--project", board, "project"], { signal }), "project");
      const target = (envelope.result as { readonly target_branch?: unknown } | undefined)?.target_branch;
      return typeof target === "string" ? target : undefined;
    },
  };
}

/** Whether the task worktree is still on disk: wt removes it (and its branch) once a merge lands. */
export async function workspaceOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The exact `wt` argv for the atask landing: merge into the target branch, keep the attempt's commits, keep the worktree. */
export function wtMergeArgv(target: string | undefined): readonly string[] {
  return ["-y", "merge", ...(target === undefined ? [] : [target]), "--no-squash", "--no-remove"];
}

/** Merges the task worktree's branch back with Worktrunk, the landing atask's contract names. */
export interface WtPort {
  merge(workspace: string, target?: string): Promise<string>;
}

/** A rebase stopped on conflicts: the commit it was replaying onto, and the files left unmerged. */
export interface RebaseConflict {
  readonly onto: string;
  readonly files: readonly string[];
}

/** Publishes the task branch, reads whether a branch already landed on a target, and clears a stopped rebase. */
export interface GitPort {
  push(workspace: string, branch: string): Promise<string>;
  /**
   * Whether `target` contains `revision` (a branch or a commit): the one fact that decides work
   * landed. Reads from `cwd`, a checkout that outlives the task worktree.
   */
  contains(cwd: string, target: string, revision: string): Promise<boolean>;
  /**
   * Aborts the rebase stopped in `workspace`, if there is one, and answers what it stopped on;
   * undefined when no rebase is in progress. Throws when the abort itself fails.
   */
  abortRebase(workspace: string): Promise<RebaseConflict | undefined>;
}

/** Opens and arms pull requests on GitHub. */
export interface GhPort {
  createPullRequest(
    workspace: string,
    request: {
      readonly branch: string;
      readonly title: string;
      readonly body: string;
      /** The branch the pull request targets; absent means the repository's default branch. */
      readonly base?: string;
    },
  ): Promise<string>;
  armAutoMerge(workspace: string, url: string): Promise<string>;
}

/** The live wt, git and gh ports over the real binaries; every program honors `signal`. */
export function liveLandingPorts(
  signal?: AbortSignal,
  program: RunProgram = runProgram,
): { readonly wt: WtPort; readonly git: GitPort; readonly gh: GhPort } {
  /** The commit a rebase in progress in `workspace` replays onto, or undefined when none is in progress. */
  async function rebaseOnto(workspace: string): Promise<string | undefined> {
    // `rebase-merge` is the default backend's state directory; `rebase-apply` the apply backend's.
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const path = outputOf(
        await program("git", ["rev-parse", "--path-format=absolute", "--git-path", `${state}/onto`], {
          cwd: workspace,
          timeoutMs: GIT_TIMEOUT_MS,
          signal,
        }),
        "git rev-parse --git-path",
      );
      try {
        return (await readFile(path, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }

  return {
    wt: {
      async merge(workspace, target) {
        return outputOf(
          await program("wt", wtMergeArgv(target), { cwd: workspace, timeoutMs: WT_TIMEOUT_MS, signal }),
          "wt merge",
        );
      },
    },
    git: {
      async push(workspace, branch) {
        return outputOf(
          await program("git", ["push", "-u", "origin", branch], { cwd: workspace, timeoutMs: GITHUB_TIMEOUT_MS, signal }),
          "git push",
        );
      },
      async contains(cwd, target, revision) {
        const run = await program("git", ["merge-base", "--is-ancestor", revision, target], {
          cwd,
          timeoutMs: GIT_TIMEOUT_MS,
          signal,
        });
        if (run.spawnError !== undefined) throw new Error(`git merge-base could not start: ${run.spawnError}`);
        if (run.code === 0) return true;
        if (run.code === 1) return false;
        throw new Error(`git merge-base exited ${run.code}: ${tailOf(run.stderr.trim() || run.stdout)}`);
      },
      async abortRebase(workspace) {
        const onto = await rebaseOnto(workspace);
        if (onto === undefined) return undefined;
        const unmerged = outputOf(
          await program("git", ["diff", "--name-only", "--diff-filter=U", "-z"], {
            cwd: workspace,
            timeoutMs: GIT_TIMEOUT_MS,
            signal,
          }),
          "git diff --diff-filter=U",
        );
        outputOf(
          await program("git", ["rebase", "--abort"], { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS, signal }),
          "git rebase --abort",
        );
        return { onto, files: unmerged.split("\0").filter((file) => file !== "") };
      },
    },
    gh: {
      async createPullRequest(workspace, request) {
        return outputOf(
          await program(
            "gh",
            [
              "pr",
              "create",
              "--head",
              request.branch,
              ...(request.base === undefined ? [] : ["--base", request.base]),
              "--title",
              request.title,
              "--body",
              request.body,
            ],
            { cwd: workspace, timeoutMs: GITHUB_TIMEOUT_MS, signal },
          ),
          "gh pr create",
        );
      },
      async armAutoMerge(workspace, url) {
        return outputOf(
          await program("gh", ["pr", "merge", url, "--auto", "--squash"], {
            cwd: workspace,
            timeoutMs: GITHUB_TIMEOUT_MS,
            signal,
          }),
          "gh pr merge --auto",
        );
      },
    },
  };
}
