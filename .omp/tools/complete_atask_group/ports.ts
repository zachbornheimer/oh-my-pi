import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import {
  ataskEnvelope,
  AtaskError,
  type AtaskOkEnvelope,
  CLAIM_TIMEOUT_MS,
  groupCapableRunAtask,
  isSettledTaskStatus,
  resolveProject,
  type RunAtask,
  runClaim,
} from "./atask.js";
import type { GroupDraft } from "./types.js";
import { tailOf } from "./util.js";

/**
 * The atask calls a group run makes, and the landed-work programs (wt, git, gh), each argv-only.
 * `claimGroup` is `atask --json claim --group <id>` and its four answers (a claim, NOT_READY, DONE,
 * STALLED) are the contract written with the atask side; `show`, `renew` and `verifyComplete` are the
 * per-task calls. Tests script fakes of these ports.
 */

/** Milliseconds `atask verify complete` may run: it executes the task's whole check suite. */
export const VERIFY_TIMEOUT_MS = 20 * 60_000;
/** `wt merge` rebases and fast-forwards. */
const WT_TIMEOUT_MS = 280_000;
/** A push, a pull-request open, or an auto-merge arm. */
const GITHUB_TIMEOUT_MS = 120_000;
/** A local git read such as `merge-base`. */
const GIT_TIMEOUT_MS = 30_000;

/** The claim's worktree facts a started run reads. */
export interface TaskAttempt {
  readonly workspace?: string;
  readonly branch?: string;
  readonly token?: string;
  /** The lease expiry in epoch milliseconds, parsed from atask's ISO string. */
  readonly lease_expires_ms?: number;
  readonly lease_active?: boolean;
}

/** A task's state as `atask show <id> --json` reports the parts a group run reads. */
export interface TaskSnapshot {
  readonly id: string;
  readonly status: string;
  readonly title?: string;
  /** The task's project name, where a landing reads its target branch from. */
  readonly project?: string;
  readonly verdict?: string;
  /** The revision atask recorded when the task completed: the landing's evidence when the worktree is gone. */
  readonly completedRevision?: string;
  /** A checkout of the task's project that outlives the task worktree: where the landing's containment check runs. */
  readonly createdCwd?: string;
  readonly attempt?: TaskAttempt;
}

/** What claiming returns: the token that owns the claim, and the worktree atask made. */
export interface ClaimedTask {
  readonly token: string;
  readonly workspace: string;
  readonly branch: string;
  /** The project's target branch a completed attempt lands on. */
  readonly target_branch?: string;
}

/** The per-task atask calls the loop and its completion gate make. Failures throw `AtaskError`. */
export interface TaskAtaskPort {
  show(id: string): Promise<TaskSnapshot>;
  renew(token: string): Promise<void>;
  /** Runs `atask verify complete` in the task worktree; throws when verification does not pass. */
  verifyComplete(workspace: string): Promise<void>;
  /** The project's atask target branch; undefined when the project names none. Never throws. */
  projectTarget(project: string): Promise<string | undefined>;
}

/** What `show --full` says about the group a caller named, before any work starts. */
export type GroupInspection =
  | {
    readonly kind: "group";
    readonly id: string;
    readonly title: string;
    /** The executable members in the whole subtree: tasks, not nested groups. */
    readonly members: number;
    /** Subtree members atask holds as drafts and will never claim. */
    readonly drafts: readonly GroupDraft[];
  }
  | { readonly kind: "not_group"; readonly id: string; readonly title: string; readonly actual: string };

/** One claim attempt on the group: a claimed member, or why none was claimed. */
export type GroupClaim =
  | { readonly kind: "claimed"; readonly claim: ClaimedTask & { readonly id: string; readonly title?: string } }
  /** Nothing claimable now; `proofsPending` means every member is complete and the group's own proofs have not run. */
  | { readonly kind: "not_ready"; readonly proofsPending: boolean }
  | { readonly kind: "done" }
  | { readonly kind: "stalled"; readonly reasons: readonly string[] };

/** A member atask shows complete, with the worktree its completed attempt left and where it lands. */
export interface CompletedMember {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly branch: string;
  /** The project's target branch; undefined when the project names none. */
  readonly target_branch?: string;
  readonly snapshot: TaskSnapshot;
}

export interface GroupAtaskPort extends Pick<TaskAtaskPort, "show" | "renew" | "verifyComplete"> {
  inspect(ref: string): Promise<GroupInspection>;
  claimGroup(group: string): Promise<GroupClaim>;
  /** Runs the group's own proofs: `atask verify complete <group>`. Throws when they do not pass. */
  verifyGroup(group: string): Promise<void>;
  /** Releases a claim: `atask claim release [--failed] --note <note> <token>`. `failed` records a failed attempt. */
  release(token: string, failed: boolean, note: string): Promise<void>;
  /** Every complete executable member under the group, nested groups included, in the order they completed. */
  completedMembers(group: string): Promise<CompletedMember[]>;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function resultOf(envelope: AtaskOkEnvelope, call: string, what: string): Json {
  const result = asObject(envelope.result);
  if (result === undefined) throw new AtaskError(call, "OUTPUT", `${what}: the result is not an object`);
  return result;
}

function requireString(source: Json, key: string, call: string, what: string): string {
  const value = asString(source[key]);
  if (value === undefined) throw new AtaskError(call, "OUTPUT", `${what}: ${key} is missing`);
  return value;
}

function requireNonEmpty(source: Json, key: string, call: string, what: string): string {
  const value = requireString(source, key, call, what);
  if (value === "") throw new AtaskError(call, "OUTPUT", `${what}: ${key} is empty`);
  return value;
}

/** The lease expiry as epoch milliseconds, when atask reports one this call can parse. */
function leaseMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The real atask CLI as the per-task port; `claimTimeoutMs` is how long one claim is waited on. */
export function cliTaskAtask(run: RunAtask, claimTimeoutMs: number = CLAIM_TIMEOUT_MS): TaskAtaskPort & {
  readonly claimTimeoutMs: number;
} {
  return {
    claimTimeoutMs,
    async show(id) {
      const what = "atask show did not return the task";
      const result = resultOf(ataskEnvelope(await run(["--json", "show", id]), "show"), "show", what);
      const attempt = asObject(result.attempt);
      const verification = asObject(result.verification);
      return {
        id: requireString(result, "id", "show", what),
        status: requireString(result, "status", "show", what),
        title: asString(result.title),
        project: asString(result.project),
        verdict: asString(asObject(verification?.complete)?.summary),
        completedRevision: asString(result.completed_revision),
        createdCwd: asString(result.created_cwd),
        attempt: attempt === undefined
          ? undefined
          : {
            workspace: asString(attempt.workspace),
            branch: asString(attempt.branch),
            token: asString(attempt.token),
            lease_expires_ms: leaseMs(asString(attempt.lease_expires_at)),
            lease_active: typeof attempt.lease_active === "boolean" ? attempt.lease_active : undefined,
          },
      };
    },
    async renew(token) {
      ataskEnvelope(await run(["--json", "claim", "renew", token]), "renew");
    },
    async verifyComplete(workspace) {
      ataskEnvelope(
        await run(["--json", "verify", "complete"], { cwd: workspace, timeoutMs: VERIFY_TIMEOUT_MS }),
        "verify complete",
      );
    },
    async projectTarget(project) {
      const board = await resolveProject(project, run);
      const envelope = ataskEnvelope(await run(["--json", "--project", board, "project"]), "project");
      const target = asObject(envelope.result)?.target_branch;
      return typeof target === "string" ? target : undefined;
    },
  };
}

/** One `show` view of a group or task, as the group walks read it. */
interface View {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  readonly status?: string;
  readonly children: readonly { readonly id: string; readonly title?: string; readonly status: string }[];
  readonly project?: string;
  readonly completed_at?: string;
  readonly attempt?: { readonly workspace?: string; readonly branch?: string };
  readonly proof: unknown;
  readonly regression: unknown;
  readonly task_checks: readonly unknown[];
}

function decodeView(envelope: AtaskOkEnvelope, ref: string): View {
  const what = `atask show did not return ${ref}`;
  const result = resultOf(envelope, "show", what);
  const children = result.children === undefined || result.children === null ? [] : result.children;
  if (!Array.isArray(children)) throw new AtaskError("show", "OUTPUT", `${what}: children is not a list`);
  const attempt = asObject(result.attempt);
  return {
    id: requireString(result, "id", "show", what),
    kind: requireString(result, "kind", "show", what),
    title: asString(result.title),
    status: asString(result.status),
    children: children.map((entry) => {
      const child = asObject(entry);
      if (child === undefined) throw new AtaskError("show", "OUTPUT", `${what}: a child is not an object`);
      return {
        id: requireString(child, "id", "show", what),
        title: asString(child.title),
        status: requireString(child, "status", "show", what),
      };
    }),
    project: asString(result.project),
    completed_at: asString(result.completed_at),
    attempt: attempt === undefined
      ? undefined
      : { workspace: asString(attempt.workspace), branch: asString(attempt.branch) },
    proof: result.proof,
    regression: result.regression,
    task_checks: Array.isArray(result.task_checks) ? result.task_checks : [],
  };
}

/** The checks a draft lacks, read from its `show` view: a task needs a proof (or task checks) and a regression. */
function missingChecks(view: View): string[] {
  const missing: string[] = [];
  const hasProof = (view.proof !== undefined && view.proof !== null) || view.task_checks.length > 0;
  if (!hasProof) missing.push("proof");
  if (view.regression === undefined || view.regression === null) missing.push("regression");
  return missing;
}

/** A completion time in epoch milliseconds; a member atask gives none sorts after the ones that have one. */
function completedAtMs(iso: string | undefined): number {
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * The real atask CLI as the group run's port: by default the first atask on PATH whose `claim` takes `--group`,
 * not whichever a bare `atask` reaches. `claimTimeoutMs` bounds one claim, which builds a worktree.
 */
export function cliGroupAtask(
  run: RunAtask = groupCapableRunAtask(),
  claimTimeoutMs: number = CLAIM_TIMEOUT_MS,
): GroupAtaskPort {
  const task = cliTaskAtask(run, claimTimeoutMs);

  async function view(ref: string, full: boolean): Promise<View> {
    const argv = full ? ["--json", "show", ref, "--full"] : ["--json", "show", ref];
    return decodeView(ataskEnvelope(await run(argv), "show"), ref);
  }

  /** Counts the executable members under one group view and names the drafts, walking nested groups. */
  async function walk(group: View): Promise<{ members: number; drafts: GroupDraft[] }> {
    let members = 0;
    const drafts: GroupDraft[] = [];
    for (const child of group.children) {
      if (child.status === "group") {
        const nested = await walk(await view(child.id, true));
        members += nested.members;
        drafts.push(...nested.drafts);
        continue;
      }
      if (child.status === "archived") continue;
      members += 1;
      if (child.status === "draft") {
        drafts.push({
          id: child.id,
          title: child.title ?? child.id,
          missing: missingChecks(await view(child.id, false)),
        });
      }
    }
    return { members, drafts };
  }

  /** Every complete executable member under one group view, nested groups walked, with its completion time. */
  async function collectCompleted(
    group: View,
    targets: Map<string, string | undefined>,
    found: { member: CompletedMember; completedAt: number }[],
  ): Promise<void> {
    for (const child of group.children) {
      if (child.status === "group") {
        await collectCompleted(await view(child.id, true), targets, found);
        continue;
      }
      if (!isSettledTaskStatus(child.status)) continue;
      const shown = await view(child.id, false);
      const { workspace, branch } = shown.attempt ?? {};
      if (workspace === undefined || branch === undefined) {
        throw new AtaskError(
          "show",
          "OUTPUT",
          `atask show ${child.id} names no worktree or branch for its completed attempt`,
        );
      }
      const project = shown.project;
      if (project !== undefined && !targets.has(project)) targets.set(project, await task.projectTarget(project));
      const target = project === undefined ? undefined : targets.get(project);
      const title = shown.title ?? child.title ?? child.id;
      found.push({
        member: {
          id: child.id,
          title,
          workspace,
          branch,
          ...(target === undefined ? {} : { target_branch: target }),
          snapshot: {
            id: child.id,
            status: shown.status ?? child.status,
            title,
            ...(project === undefined ? {} : { project }),
          },
        },
        completedAt: completedAtMs(shown.completed_at),
      });
    }
  }

  return {
    show: task.show,
    renew: task.renew,
    verifyComplete: task.verifyComplete,
    async inspect(ref) {
      const top = await view(ref, true);
      const title = top.title ?? top.id;
      if (top.kind !== "group") return { kind: "not_group", id: top.id, title, actual: top.kind };
      const { members, drafts } = await walk(top);
      return { kind: "group", id: top.id, title, members, drafts };
    },
    async claimGroup(group) {
      let envelope: AtaskOkEnvelope;
      try {
        envelope = ataskEnvelope(await runClaim(run, ["--json", "claim", "--group", group], claimTimeoutMs), "claim");
      } catch (error) {
        if (!(error instanceof AtaskError)) throw error;
        const details = asObject(error.details);
        if (error.code === "DONE") return { kind: "done" };
        if (error.code === "NOT_READY") {
          return { kind: "not_ready", proofsPending: details?.group_proofs_pending === true };
        }
        if (error.code === "STALLED") {
          const reasons = Array.isArray(details?.reasons)
            ? details.reasons.filter((reason): reason is string => typeof reason === "string")
            : [];
          return { kind: "stalled", reasons: reasons.length === 0 ? [error.message] : reasons };
        }
        throw error;
      }
      const what = "atask claim --group assigned no task";
      const result = resultOf(envelope, "claim", what);
      const assigned = asObject(result.task);
      if (assigned === undefined) throw new AtaskError("claim", "OUTPUT", `${what}: task is missing`);
      const id = requireNonEmpty(assigned, "id", "claim", what);
      const title = asString(assigned.title);
      return {
        kind: "claimed",
        claim: {
          id,
          ...(title === undefined ? {} : { title }),
          token: requireNonEmpty(result, "token", "claim", what),
          workspace: requireNonEmpty(result, "workspace", "claim", what),
          branch: requireNonEmpty(result, "branch", "claim", what),
          target_branch: asString(result.target_branch) ?? asString(envelope.target_branch),
        },
      };
    },
    async verifyGroup(group) {
      ataskEnvelope(
        await run(["--json", "verify", "complete", group], { timeoutMs: VERIFY_TIMEOUT_MS }),
        "verify complete",
      );
    },
    async release(token, failed, note) {
      const argv = failed
        ? ["--json", "claim", "release", "--failed", "--note", note, token]
        : ["--json", "claim", "release", "--note", note, token];
      ataskEnvelope(await run(argv), "release");
    },
    async completedMembers(group) {
      const found: { member: CompletedMember; completedAt: number }[] = [];
      await collectCompleted(await view(group, true), new Map(), found);
      return found
        .sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0))
        .map((entry) => entry.member);
    },
  };
}

/** One landed-work program run: wt, git, or gh. */
export interface ProgramRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not start, for example when it is not installed. */
  readonly spawnError?: string;
}

/** The binaries the landed-work ports run. A closed set: a name outside it is a compile error. */
export type LandedWorkBinary = "wt" | "git" | "gh";

/** Runs one program with an argv array, so nothing is ever interpreted by a shell. */
export type RunProgram = (
  binary: LandedWorkBinary,
  argv: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number },
) => Promise<ProgramRun>;

/** One literal spawn per allowed binary: a name outside {@link LandedWorkBinary} never reaches a process. */
function spawnLandedWork(binary: LandedWorkBinary, argv: readonly string[], cwd: string | undefined) {
  const spawned = { cwd, env: process.env, shell: false } as const;
  switch (binary) {
    case "wt":
      return spawn("wt", [...argv], spawned);
    case "git":
      return spawn("git", [...argv], spawned);
    case "gh":
      return spawn("gh", [...argv], spawned);
    default:
      throw new Error(`refusing to run ${String(binary)}: not one of wt, git, gh`);
  }
}

export const runProgram: RunProgram = (binary, argv, options) => {
  const { promise, resolve } = Promise.withResolvers<ProgramRun>();
  const child = spawnLandedWork(binary, argv, options.cwd);
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ code: 1, stdout: "", stderr: "", spawnError: error.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? 1, stdout, stderr });
  });
  return promise;
};

/** Whether the task worktree is still on disk: wt removes it (and its branch) once a merge lands. */
export async function workspaceOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The program's trimmed stdout, or the failure naming what exited and what it printed. */
function outputOf(run: ProgramRun, what: string): string {
  if (run.spawnError !== undefined) throw new Error(`${what} could not start: ${run.spawnError}`);
  if (run.code !== 0) {
    const printed = tailOf(run.stderr.trim() || run.stdout);
    throw new Error(`${what} exited ${run.code}${printed === "" ? "" : `: ${printed}`}`);
  }
  return run.stdout.trim();
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

/** Opens pull requests on GitHub. */
export interface GhPort {
  createPullRequest(
    workspace: string,
    request: { readonly branch: string; readonly title: string; readonly body: string },
  ): Promise<string>;
}

/** The commit a rebase in progress in `workspace` replays onto, or undefined when none is in progress. */
async function rebaseOnto(run: RunProgram, workspace: string): Promise<string | undefined> {
  // `rebase-merge` is the default backend's state directory; `rebase-apply` the apply backend's.
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = outputOf(
      await run("git", ["rev-parse", "--path-format=absolute", "--git-path", `${state}/onto`], {
        cwd: workspace,
        timeoutMs: GIT_TIMEOUT_MS,
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

/** The live landed-work ports over the real binaries (or over `run`, for tests). */
export function liveLandingPorts(run: RunProgram = runProgram): { wt: WtPort; git: GitPort; gh: GhPort } {
  return {
    wt: {
      async merge(workspace, target) {
        return outputOf(await run("wt", wtMergeArgv(target), { cwd: workspace, timeoutMs: WT_TIMEOUT_MS }), "wt merge");
      },
    },
    git: {
      async push(workspace, branch) {
        return outputOf(
          await run("git", ["push", "-u", "origin", branch], { cwd: workspace, timeoutMs: GITHUB_TIMEOUT_MS }),
          "git push",
        );
      },
      async contains(cwd, target, revision) {
        const result = await run("git", ["merge-base", "--is-ancestor", revision, target], {
          cwd,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (result.spawnError !== undefined) throw new Error(`git merge-base could not start: ${result.spawnError}`);
        if (result.code === 0) return true;
        if (result.code === 1) return false;
        throw new Error(`git merge-base exited ${result.code}: ${tailOf(result.stderr.trim() || result.stdout)}`);
      },
      async abortRebase(workspace) {
        const onto = await rebaseOnto(run, workspace);
        if (onto === undefined) return undefined;
        const unmerged = outputOf(
          await run("git", ["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS }),
          "git diff --diff-filter=U",
        );
        outputOf(await run("git", ["rebase", "--abort"], { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS }), "git rebase --abort");
        return { onto, files: unmerged.split("\0").filter((file) => file !== "") };
      },
    },
    gh: {
      async createPullRequest(workspace, request) {
        const { branch, title, body: description } = request;
        const argv = ["pr", "create", "--head", branch, "--title", title, "--body", description];
        const created = await run("gh", argv, { cwd: workspace, timeoutMs: GITHUB_TIMEOUT_MS });
        return outputOf(created, "gh pr create");
      },
    },
  };
}
