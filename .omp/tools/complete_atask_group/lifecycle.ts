import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSettledTaskStatus } from "./atask.js";
import {
  type GhPort,
  type GitPort,
  type RebaseConflict,
  type TaskAtaskPort,
  type TaskSnapshot,
  workspaceOnDisk,
  type WtPort,
} from "./ports.js";
import type { GroupLanding } from "./types.js";
import { type Clock, messageOf, shQuote, tailOf } from "./util.js";
import type { WorkerPort } from "./worker.js";

/**
 * The worker lifecycle a group run shares per member: the worker's command, the completion gate, lease
 * renewal, stopping a settled worker, and the landing. Pure against its ports.
 */

/** The headless harness this tool runs inside the task worktree. */
export const WORKER_HARNESS = "omp";

/** How often the loop re-reads the task's state and the worker's status. */
export const POLL_MS = 2_000;

/** Extra seconds past the worker's own budget before the job is killed. */
export const WORKER_GRACE_S = 60;

/** How long before the claim lease expires the loop renews it. */
export const RENEW_MARGIN_MS = 10 * 60_000;

/** How long the loop waits for a settled worker to exit before stopping it. */
export const EXIT_GRACE_MS = 15_000;

/** The model role the worker runs on: the user's omp `task` role, strong enough to finish a ticket alone. */
export const WORKER_MODEL = "@task";

/** The overlay that pins the worker's launch config, passed as an absolute path and only when the file exists. */
export function workerConfigPath(): string | undefined {
  const path = join(homedir(), ".omp", "agent", "overlays", "pin-model.yml");
  return existsSync(path) ? path : undefined;
}

/** The prompt the worker session runs. */
export function defaultPrompt(id: string): string {
  return `You hold the claim on atask objective ${id}, and this worktree is its workspace. `
    + `Read the handoff with \`atask context ${id}\`, do the work, and commit it with \`wt step commit\`. `
    + `If the handoff records a \`--next\` or the branch already carries commits, this is a resumed attempt: `
    + `continue from that recorded next step and those commits instead of starting over. `
    + `Run the proof and regression checks, then finish only after \`atask verify complete\` passes. `
    + `For a code change of any size, delegate the editing to the \`code-improver\` subagent (the task tool) `
    + `with the objective's outcome and the worktree path; you keep the claim, the atask bookkeeping, and `
    + `the verification. Do not delegate the decision to release or complete. `
    + `If you cannot complete the objective, record why with \`atask log --next ...\` and release the claim `
    + `with \`atask claim release --note ...\` instead of leaving it silent.`;
}

/** The worker's whole command: the harness unattended in print mode, pinned to one model, with any extra workspace dirs. */
export function workerCommand(
  input: { readonly id: string; readonly add_dirs: readonly string[]; readonly prompt?: string },
  /** The overlay to pass: undefined picks the pin-model overlay when it exists, null passes none. */
  config?: string | null,
): string {
  const overlay = config === undefined ? workerConfigPath() : config ?? undefined;
  const parts = [WORKER_HARNESS, "--auto-approve", "--model", WORKER_MODEL];
  if (overlay !== undefined) parts.push("--config", shQuote(overlay));
  for (const dir of input.add_dirs) parts.push("--add-dir", shQuote(dir));
  parts.push("-p", shQuote(input.prompt ?? defaultPrompt(input.id)));
  return parts.join(" ");
}

export type WaitOutcome =
  | { kind: "settled"; snapshot: TaskSnapshot }
  | { kind: "failed"; error: string };

/**
 * Each task's latest started worker, so a later start in this process attaches to it instead of
 * starting a second one. The record is only read through the port that wrote it.
 */
const startedWorkers = new Map<string, { readonly port: WorkerPort; readonly job_id: string }>();

export function recordWorkerJob(worker: WorkerPort, taskId: string, job_id: string): void {
  startedWorkers.set(taskId, { port: worker, job_id });
}

/**
 * The task's recorded worker job and whether it is still alive. Liveness is the worker port's own
 * status, never the claim's status: a claim reads `interrupted` when its lease lapsed while its
 * worker process still runs, and stays `claimed` after the worker has died. A recorded job that is
 * no longer alive is still returned (dead, not missing) so a caller can gate on it.
 */
export async function recordedWorkerJob(
  worker: WorkerPort,
  taskId: string,
): Promise<{ readonly job_id: string; readonly alive: boolean } | undefined> {
  const candidates: string[] = [];
  const started = startedWorkers.get(taskId);
  if (started?.port === worker) candidates.push(started.job_id);
  if (worker.find !== undefined) {
    const found = await worker.find(taskId);
    if (found !== undefined && !candidates.includes(found)) candidates.push(found);
  }
  let dead: string | undefined;
  for (const job_id of candidates) {
    if ((await worker.status(job_id)).state === "running") {
      recordWorkerJob(worker, taskId, job_id);
      return { job_id, alive: true };
    }
    dead ??= job_id;
  }
  return dead === undefined ? undefined : { job_id: dead, alive: false };
}

/** Extends the claim, runs the completion gate in the worktree, and reads the verdict back. */
export async function completeObjective(
  id: string,
  claim: { readonly token: string; readonly workspace: string },
  job: { readonly output_tail?: string },
  atask: Pick<TaskAtaskPort, "renew" | "verifyComplete" | "show">,
): Promise<WaitOutcome> {
  try {
    await atask.renew(claim.token);
  } catch {
    // verify names a dead claim better than a failed renewal
  }
  try {
    await atask.verifyComplete(claim.workspace);
  } catch (error) {
    const tail = job.output_tail === undefined || job.output_tail.trim() === ""
      ? ""
      : ` Worker output tail: ${tailOf(job.output_tail)}`;
    return { kind: "failed", error: `atask verify complete did not pass for ${id}: ${messageOf(error)}.${tail}` };
  }
  const snapshot = await atask.show(id);
  if (!isSettledTaskStatus(snapshot.status)) {
    return { kind: "failed", error: `atask verify complete returned while ${id} was still ${snapshot.status}` };
  }
  return { kind: "settled", snapshot };
}

/** Renews the claim's lease once it is within `RENEW_MARGIN_MS` of expiring; a failed renewal is left to the completion gate to name. */
export async function renewNearExpiry(
  snapshot: TaskSnapshot | undefined,
  token: string,
  atask: Pick<TaskAtaskPort, "renew">,
  clock: Clock,
): Promise<void> {
  const expires = snapshot?.attempt?.lease_expires_ms;
  if (expires === undefined || expires - clock.now() >= RENEW_MARGIN_MS) return;
  try {
    await atask.renew(token);
  } catch {
    // the completion gate names a dead claim better than a failed renewal
  }
}

/** Waits briefly for a settled worker to exit, then stops it so landing finds a quiet worktree. */
export async function stopWhenSettled(
  jobId: string,
  worker: WorkerPort,
  clock: Clock,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = clock.now() + EXIT_GRACE_MS;
  while (clock.now() < deadline) {
    if ((await worker.status(jobId)).state !== "running") return;
    await clock.sleep(1000, signal);
  }
  if ((await worker.status(jobId)).state === "running") worker.stop(jobId);
}

/** How one member's landing ended. */
export interface Landing {
  readonly on_complete: GroupLanding;
  readonly outcome: "merged" | "pull_request" | "left" | "failed";
  readonly url?: string;
  readonly error?: string;
  /** The rebase `wt merge` stopped on and the landing aborted: the target commit and the conflicting files. */
  readonly conflict?: { readonly onto: string; readonly files: readonly string[] };
}

/**
 * Whether the target branch already holds a revision. `wt merge` can merge and still exit
 * nonzero, so containment, not wt's exit code, decides that work landed. An unknown target or an
 * unanswerable check is never a landing.
 */
async function workLandedOnTarget(
  git: GitPort,
  workspace: string,
  target: string | undefined,
  revision: string,
): Promise<boolean> {
  if (target === undefined) return false;
  try {
    return await git.contains(workspace, target, revision);
  } catch {
    return false;
  }
}

/**
 * The landing of a task whose worktree is gone: wt removes worktree and branch together once a
 * merge lands. Whether the work reached the target is still answerable: atask recorded the revision
 * it verified and a checkout that outlives the worktree, and containment decides from there.
 */
async function workAlreadyLanded(
  on_complete: GroupLanding,
  git: GitPort,
  workspace: string,
  branch: string,
  snapshot: TaskSnapshot,
  target: string | undefined,
): Promise<Landing> {
  const revision = snapshot.completedRevision ?? branch;
  const checkout = snapshot.createdCwd;
  const gone = `the worktree ${workspace} is gone`;
  if (checkout === undefined || target === undefined) {
    return {
      on_complete,
      outcome: "failed",
      error: `${gone}, and its landing could not be checked: `
        + `${target === undefined ? "no target branch is recorded" : `atask recorded no checkout of ${snapshot.project ?? "the project"}`}`,
    };
  }
  try {
    if (await git.contains(checkout, target, revision)) return { on_complete, outcome: "merged" };
  } catch (error) {
    return {
      on_complete,
      outcome: "failed",
      error: `${gone}, and whether ${revision} reached ${target} could not be read from ${checkout}: ${messageOf(error)}`,
    };
  }
  return {
    on_complete,
    outcome: "failed",
    error: `${gone}; ${revision} is not in ${target}, so the task's verified work is not landed`,
  };
}

/**
 * The failed `merge` landing. `wt merge` that stops on a rebase conflict leaves the rebase in
 * progress, and every later landing in that worktree then fails with "a git operation is already
 * in progress"; so the stopped rebase is aborted here, and the answer names the conflicting files
 * and the target commit the rebase was replaying onto.
 */
async function failedMerge(
  git: GitPort,
  workspace: string,
  branch: string,
  target: string | undefined,
  wtError: string,
): Promise<Landing> {
  const failed = `wt merge did not land ${branch}: ${wtError}`;
  let conflict: RebaseConflict | undefined;
  try {
    conflict = await git.abortRebase(workspace);
  } catch (error) {
    return {
      on_complete: "merge",
      outcome: "failed",
      error: `${failed}; the stopped rebase could not be aborted: ${messageOf(error)}`,
    };
  }
  if (conflict === undefined) return { on_complete: "merge", outcome: "failed", error: failed };
  const files = conflict.files.length === 0 ? "none reported" : conflict.files.join(", ");
  return {
    on_complete: "merge",
    outcome: "failed",
    error: `${failed}; rebasing onto ${target ?? "the target"} at ${conflict.onto} conflicted in ${files}; `
      + "aborted the rebase, the worktree is back on the task branch",
    conflict: { onto: conflict.onto, files: [...conflict.files] },
  };
}

export async function land(
  input: { readonly onComplete: GroupLanding },
  workspace: string,
  branch: string,
  snapshot: TaskSnapshot,
  deps: {
    readonly wt: WtPort;
    readonly git: GitPort;
    readonly gh: GhPort;
    readonly lander?: string;
    /** Whether the task worktree is still on disk; wt removes it once a merge lands. */
    readonly workspaceExists?: (path: string) => Promise<boolean>;
  },
  target?: string,
): Promise<Landing> {
  const on_complete = input.onComplete;
  if (on_complete === "nil") return { on_complete, outcome: "left" };
  // A task can arrive here after its own landing removed the worktree: wt deletes worktree and
  // branch together, so nothing is left to merge. Its verified work is decided by containment.
  if (await (deps.workspaceExists ?? workspaceOnDisk)(workspace) === false) {
    return workAlreadyLanded(on_complete, deps.git, workspace, branch, snapshot, target);
  }
  if (on_complete === "merge") {
    try {
      await deps.wt.merge(workspace, target);
      return { on_complete, outcome: "merged" };
    } catch (error) {
      if (await workLandedOnTarget(deps.git, workspace, target, branch)) return { on_complete, outcome: "merged" };
      return failedMerge(deps.git, workspace, branch, target, messageOf(error));
    }
  }
  try {
    await deps.git.push(workspace, branch);
    const url = await deps.gh.createPullRequest(workspace, {
      branch,
      title: snapshot.title ?? `${snapshot.id}: ${branch}`,
      body: `Landed by ${deps.lander ?? "complete_atask_group"} for atask objective ${snapshot.id}.`,
    });
    return { on_complete, outcome: "pull_request", url };
  } catch (error) {
    return { on_complete, outcome: "failed", error: messageOf(error) };
  }
}
