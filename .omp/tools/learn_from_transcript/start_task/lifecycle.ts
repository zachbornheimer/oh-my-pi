import { isSettledTaskStatus } from "./atask_cli.js";
import { type Clock, systemClock } from "./clock.js";
import {
  type ClaimedTask,
  type GhPort,
  type GitPort,
  type RebaseConflict,
  type StartTaskAtaskPort,
  type TaskSnapshot,
  workspaceOnDisk,
  type WtPort,
} from "./ports.js";
import {
  type StartAtaskTaskCompletion,
  type StartAtaskTaskInput,
  type StartAtaskTaskOutput,
  WORKER_BUDGET_S,
} from "./schemas.js";
import { messageOf, shQuote, tailOf } from "./text.js";
import type { WorkerPort } from "./worker.js";

export { WORKER_BUDGET_S };

/**
 * The start_atask_task flow: show the objective, claim it (atask makes or reuses the task
 * worktree), spawn the omp session inside that worktree, wait until atask settles it — running
 * the completion gate itself when the session ends first — then land the work per onComplete.
 * Pure against its ports, like the wait loop; the live wiring sits in `index.ts`.
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

/**
 * How long one call waits for a claim that never recorded its worktree to lapse. atask records such
 * a claim with the short claim window instead of the whole lease, so this covers that window and
 * nothing more: past it the refusal names the time to call again rather than holding the caller.
 */
export const UNSTORED_CLAIM_WAIT_MS = 6 * 60_000;

/** The model role the worker runs on: the user's omp `task` role, strong enough to finish a ticket alone. */
export const WORKER_MODEL = "@task";

/** The prompt the worker session runs when the caller supplies none. */
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

/**
 * The worker's whole command: the harness unattended in print mode, pinned to one model, with an
 * optional config overlay (an absolute path; absent means none) and any extra workspace dirs.
 */
export function workerCommand(
  input: Pick<StartAtaskTaskInput, "add_dirs" | "prompt"> & { readonly id: string },
  config?: string,
): string {
  const parts = [WORKER_HARNESS, "--auto-approve", "--model", WORKER_MODEL];
  if (config !== undefined) parts.push("--config", shQuote(config));
  for (const dir of input.add_dirs) parts.push("--add-dir", shQuote(dir));
  parts.push("-p", shQuote(input.prompt ?? defaultPrompt(input.id)));
  return parts.join(" ");
}

export interface StartTaskDependencies {
  readonly atask: StartTaskAtaskPort;
  readonly worker: WorkerPort;
  readonly wt: WtPort;
  readonly git: GitPort;
  readonly gh: GhPort;
  readonly clock?: Clock;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  /** Absolute path of the omp config overlay the worker loads; absent runs the worker without one. */
  readonly workerConfig?: string;
  /** Latest-state sink: the live tool turns it into `onUpdate` heartbeats. */
  readonly report?: (message: string) => void;
  /** Whether the task worktree is still on disk; tests script it, the live landing reads the filesystem. */
  readonly workspaceExists?: (path: string) => Promise<boolean>;
}

type Report = (message: string) => void;
const silent: Report = () => undefined;

/**
 * One live run: either this call can see the worker's job (it started the worker, or one is
 * recorded for the task), or it attaches blindly to a claim whose worker it cannot see.
 */
type Run =
  | { kind: "start"; token: string; workspace: string; branch: string; job_id: string }
  | { kind: "attach"; token: string; workspace: string; branch: string };

export type WaitOutcome =
  | { kind: "running"; job_id: string }
  | { kind: "settled"; snapshot: TaskSnapshot }
  | { kind: "failed"; error: string };

/** One worker this process started: the port that started it, and its job. */
interface StartedWorker {
  readonly port: WorkerPort;
  readonly job_id: string;
}

/**
 * Each task's latest started worker, so a later call from this process attaches to it instead of
 * starting a second one. The record is only read through the port that wrote it: a later call
 * resolves a fresh port object, and a job one port cannot answer for is not evidence of anything.
 */
const startedWorkers = new Map<string, StartedWorker>();

/** Records the task's started worker, so a later call from this process attaches to it. */
export function recordWorkerJob(worker: WorkerPort, taskId: string, job_id: string): void {
  startedWorkers.set(taskId, { port: worker, job_id });
}

/**
 * The task's recorded worker job and whether it is still alive. Liveness is the worker port's own
 * status, never the claim's status: a claim reads `interrupted` when its lease lapsed while its
 * worker process still runs, and stays `claimed` after the worker has died. A recorded job that is
 * no longer alive is still returned — dead, not missing — so a caller can gate on it and report
 * its last output.
 */
export async function recordedWorkerJob(
  worker: WorkerPort,
  taskId: string,
): Promise<{ readonly job_id: string; readonly alive: boolean } | undefined> {
  const candidates: string[] = [];
  const started = startedWorkers.get(taskId);
  if (started?.port === worker) candidates.push(started.job_id);
  if (typeof worker.find === "function") {
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

/** A claim this call holds, for `startOrAttach`: the task, its token, and the worktree to run in. */
interface ClaimToRun {
  readonly id: string;
  readonly token: string;
  readonly workspace: string;
  readonly branch: string;
}

/** Starting a claimed task: the run to wait on, or the failure to answer with. */
type StartedRun =
  | { readonly run: Extract<Run, { kind: "start" }> }
  | { readonly failure: StartAtaskTaskOutput };

/**
 * The run for a claim this call holds: a live recorded worker is attached to — never given a
 * second spawn — and a dead or missing one starts fresh in the claim's worktree.
 */
async function startOrAttach(
  claim: ClaimToRun,
  input: StartAtaskTaskInput & { readonly id: string },
  worker: WorkerPort,
  workerConfig: string | undefined,
  report: Report,
): Promise<StartedRun> {
  const recorded = await recordedWorkerJob(worker, claim.id);
  if (recorded?.alive === true) {
    report(`attached to the live worker ${recorded.job_id} for ${claim.id}`);
    return {
      run: { kind: "start", token: claim.token, workspace: claim.workspace, branch: claim.branch, job_id: recorded.job_id },
    };
  }
  report(`starting the worker for ${claim.id} in ${claim.workspace}`);
  try {
    const job = await worker.start({
      command: workerCommand(input, workerConfig),
      cwd: claim.workspace,
      taskId: claim.id,
      timeoutSeconds: (input.worker_timeout_s ?? WORKER_BUDGET_S) + WORKER_GRACE_S,
    });
    recordWorkerJob(worker, claim.id, job.job_id);
    return {
      run: { kind: "start", token: claim.token, workspace: claim.workspace, branch: claim.branch, job_id: job.job_id },
    };
  } catch (error) {
    return {
      failure: {
        task_id: claim.id,
        status: "failed",
        workspace: claim.workspace,
        branch: claim.branch,
        error: `the worker could not start in ${claim.workspace}: ${messageOf(error)}`,
      },
    };
  }
}

/** Extends the claim, runs the completion gate in the worktree, and reads the verdict back. */
export async function completeObjective(
  id: string,
  claim: { readonly token: string; readonly workspace: string },
  job: { readonly output_tail?: string },
  atask: Pick<StartTaskAtaskPort, "renew" | "verifyComplete" | "show">,
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

/**
 * A claim atask recorded before its worktree exists holds a task nobody can work on and nobody can
 * release — the token is printed only when the claim finishes, and only the worktree stores it.
 * Its lease is therefore the only thing that frees the task, and atask grants such a claim the
 * short claim window rather than the whole lease. Waits for that window to lapse, returning the
 * first snapshot that is no longer such a claim, or the last one if the wait runs out.
 */
export async function waitOutUnstoredClaim(
  snapshot: TaskSnapshot,
  atask: Pick<StartTaskAtaskPort, "show">,
  clock: Clock,
  pollMs: number,
  signal?: AbortSignal,
): Promise<TaskSnapshot> {
  const unstored = (s: TaskSnapshot): boolean => s.status === "claimed" && s.attempt?.workspace === undefined;
  const now = clock.now();
  const deadline = Math.min(snapshot.attempt?.lease_expires_ms ?? now + UNSTORED_CLAIM_WAIT_MS, now + UNSTORED_CLAIM_WAIT_MS);
  let latest = snapshot;
  while (clock.now() < deadline && unstored(latest)) {
    await clock.sleep(Math.min(pollMs, deadline - clock.now()), signal);
    latest = await atask.show(snapshot.id);
  }
  return latest;
}

/** Renews the claim's lease once it is within `RENEW_MARGIN_MS` of expiring; a failed renewal is left to the completion gate to name. */
export async function renewNearExpiry(
  snapshot: TaskSnapshot | undefined,
  token: string,
  atask: Pick<StartTaskAtaskPort, "renew">,
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

interface WaitInputs {
  readonly input: StartAtaskTaskInput & { readonly id: string };
  readonly run: Run;
  readonly atask: StartTaskAtaskPort;
  readonly worker: WorkerPort;
  readonly clock: Clock;
  readonly pollMs: number;
  readonly signal?: AbortSignal;
  readonly report: Report;
}

/**
 * Polls until atask settles the task (whoever did it), the started session ends first (then the
 * completion gate decides), or the budget runs out. A budget that runs out never answers
 * `running` without checking: the answer is always backed by a live worker process.
 */
async function waitForSettled(wait: WaitInputs): Promise<WaitOutcome> {
  const { input, run, atask, worker, clock, pollMs, signal, report } = wait;
  const startedAt = clock.now();
  const budgetMs = input.timeout_s * 1000;

  for (;;) {
    signal?.throwIfAborted();
    const remaining = budgetMs - (clock.now() - startedAt);
    if (remaining <= 0) return finishWait(wait);

    let snapshot: TaskSnapshot | undefined;
    try {
      snapshot = await atask.show(input.id);
    } catch {
      snapshot = undefined; // the task's state is unknown this round; the worker's decides below
    }
    if (snapshot !== undefined && isSettledTaskStatus(snapshot.status)) {
      return { kind: "settled", snapshot };
    }

    if (run.kind === "start") {
      const job = await worker.status(run.job_id);
      if (job.state !== "running") {
        // the session ended; only atask's own verification can settle the objective now
        report(`worker ${run.job_id} ended (${job.state}); running atask verify complete for ${input.id}`);
        return await completeObjective(input.id, run, job, atask);
      }
      report(`waiting on ${input.id}: task ${snapshot?.status ?? "unknown"}, worker ${run.job_id} running`);
      await renewNearExpiry(snapshot, run.token, atask, clock);
    } else {
      report(`waiting on ${input.id}: task ${snapshot?.status ?? "unknown"}, worker not visible to this call`);
    }

    await clock.sleep(Math.min(pollMs, remaining), signal);
  }
}

/**
 * The answer when the caller's budget runs out. A run that can see its worker re-reads it once
 * more, so `running` is always backed by a live process and a worker that just ended goes to the
 * gate. A blind attach cannot see the worker it waits on, so it never answers `running`: the
 * completion gate reports what atask's own verification says.
 */
async function finishWait(wait: WaitInputs): Promise<WaitOutcome> {
  const { input, run, atask, worker, report } = wait;
  if (run.kind === "attach") {
    report(`wait budget ended; running atask verify complete for ${input.id}`);
    return await completeObjective(input.id, run, {}, atask);
  }
  const job = await worker.status(run.job_id);
  if (job.state === "running") return { kind: "running", job_id: run.job_id };
  report(`worker ${run.job_id} ended (${job.state}); running atask verify complete for ${input.id}`);
  return await completeObjective(input.id, run, job, atask);
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

/**
 * Whether the target branch already holds a revision. `wt merge` can merge and still exit
 * nonzero (for example on its shell-integration warning), so containment, not wt's exit code,
 * decides that work landed. An unknown target or an unanswerable check is never a landing.
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
 * The landing of a task whose worktree is gone — wt removes worktree and branch together once a
 * merge lands, so a task landed through this flow loses both. Whether the work reached the target
 * is still answerable: atask recorded the revision it verified and a checkout that outlives the
 * worktree, and containment decides from there. A revision outside the target is named as such,
 * never as a spawn failure that reads like a missing binary.
 */
async function workAlreadyLanded(
  on_complete: "merge" | "pr-auto" | "pr",
  git: GitPort,
  workspace: string,
  branch: string,
  snapshot: TaskSnapshot,
  target: string | undefined,
): Promise<StartAtaskTaskCompletion> {
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
 * in progress"; so the stopped rebase is aborted here, leaving the worktree on the task branch, and
 * the answer names the conflicting files and the target commit the rebase was replaying onto.
 */
async function failedMerge(
  git: GitPort,
  workspace: string,
  branch: string,
  target: string | undefined,
  wtError: string,
): Promise<StartAtaskTaskCompletion> {
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

/** Applies `onComplete` to a verified task's worktree: merge, pull request, or leave it. */
export async function land(
  input: Pick<StartAtaskTaskInput, "onComplete">,
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
    readonly signal?: AbortSignal;
  },
  target?: string,
): Promise<StartAtaskTaskCompletion> {
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
      deps.signal?.throwIfAborted();
      if (await workLandedOnTarget(deps.git, workspace, target, branch)) return { on_complete, outcome: "merged" };
      return failedMerge(deps.git, workspace, branch, target, messageOf(error));
    }
  }
  try {
    await deps.git.push(workspace, branch);
    const url = await deps.gh.createPullRequest(workspace, {
      branch,
      title: snapshot.title ?? `${snapshot.id}: ${branch}`,
      body: `Landed by ${deps.lander ?? "start_atask_task"} for atask objective ${snapshot.id}.`,
      ...(target === undefined ? {} : { base: target }),
    });
    if (on_complete === "pr-auto") await deps.gh.armAutoMerge(workspace, url);
    return { on_complete, outcome: "pull_request", url };
  } catch (error) {
    deps.signal?.throwIfAborted();
    return { on_complete, outcome: "failed", error: messageOf(error) };
  }
}

/** The task a call acts on once it has a run to wait on. */
interface Resolved {
  readonly taskId: string;
  readonly input: StartAtaskTaskInput & { readonly id: string };
  readonly run: Run;
  /** The branch a landing merges into; undefined falls back to wt's default branch. */
  readonly target: string | undefined;
}

/**
 * Starts one atask objective: claims it (atask creates or reuses the worktree), runs the omp
 * session inside that worktree, and settles only through atask's own verification — the answer
 * carries atask's verdict, never the worker's. A claimed task is attached to, never given a
 * second worker. Every atask failure is a `refused` answer, never a throw; an aborted `signal`
 * throws, and leaves the worker running.
 */
export async function startAtaskTask(
  input: StartAtaskTaskInput,
  dependencies: StartTaskDependencies,
): Promise<StartAtaskTaskOutput> {
  const { atask, worker, wt, git, gh, signal } = dependencies;
  const clock = dependencies.clock ?? systemClock;
  const pollMs = dependencies.pollMs ?? POLL_MS;
  const report = dependencies.report ?? silent;
  const workspaceExists = dependencies.workspaceExists ?? workspaceOnDisk;
  const workerConfig = dependencies.workerConfig;

  const resolved = await resolveRun();
  if ("output" in resolved) return resolved.output;
  const { taskId, run, target } = resolved.resolved;

  const waited = await waitForSettled({ input: resolved.resolved.input, run, atask, worker, clock, pollMs, signal, report });
  if (waited.kind === "running") {
    return { task_id: taskId, status: "running", workspace: run.workspace, branch: run.branch, job_id: waited.job_id };
  }
  if (waited.kind === "failed") {
    return {
      task_id: taskId,
      status: "failed",
      workspace: run.workspace,
      branch: run.branch,
      ...(run.kind === "start" ? { job_id: run.job_id } : {}),
      error: waited.error,
    };
  }

  if (run.kind === "start") await stopWhenSettled(run.job_id, worker, clock, signal);
  report(`landing ${taskId} (${input.onComplete})`);
  const completion = await land(input, run.workspace, run.branch, waited.snapshot, { wt, git, gh, workspaceExists, signal }, target);
  return {
    task_id: taskId,
    status: "settled",
    workspace: run.workspace,
    branch: run.branch,
    ...(run.kind === "start" ? { job_id: run.job_id } : {}),
    verdict: waited.snapshot.verdict,
    summary: `task ${taskId} ${waited.snapshot.status}`,
    completion,
  };

  /** Shows, claims or attaches: the run to wait on, or the final answer when nothing is waited on. */
  async function resolveRun(): Promise<{ resolved: Resolved } | { output: StartAtaskTaskOutput }> {
    // No id: atask claim assigns the oldest eligible task. The caller does not pick.
    const id = input.id;
    if (id === undefined) {
      report(input.project === undefined ? "claiming the oldest eligible task" : `claiming the oldest eligible task in ${input.project}`);
      let assigned: ClaimedTask & { readonly id: string };
      try {
        assigned = await atask.assign(input.project);
      } catch (error) {
        signal?.throwIfAborted();
        return { output: { task_id: "unassigned", status: "refused", error: messageOf(error) } };
      }
      const named = { ...input, id: assigned.id };
      // atask assigns the oldest eligible task, which can be one this process already gave a
      // worker; a live recorded worker is attached to, never given a second spawn.
      const started = await startOrAttach(assigned, named, worker, workerConfig, report);
      if ("failure" in started) return { output: started.failure };
      return { resolved: { taskId: assigned.id, input: named, run: started.run, target: assigned.target_branch } };
    }

    let snapshot: TaskSnapshot;
    try {
      snapshot = await atask.show(id);
    } catch (error) {
      signal?.throwIfAborted();
      return { output: { task_id: id, status: "refused", error: messageOf(error) } };
    }
    const named = { ...input, id };

    if (isSettledTaskStatus(snapshot.status)) {
      const workspace = snapshot.attempt?.workspace;
      const branch = snapshot.attempt?.branch ?? `atask/${snapshot.id}`;
      const completion: StartAtaskTaskCompletion = workspace === undefined
        ? {
          on_complete: input.onComplete,
          outcome: "failed",
          error: `task ${snapshot.id} is ${snapshot.status} and records no worktree; nothing was landed`,
        }
        : await land(
          input,
          workspace,
          branch,
          snapshot,
          { wt, git, gh, workspaceExists, signal },
          snapshot.project === undefined ? undefined : await atask.projectTarget(snapshot.project),
        );
      return {
        output: {
          task_id: snapshot.id,
          status: "settled",
          verdict: snapshot.verdict,
          summary: `task ${snapshot.id} was already ${snapshot.status}`,
          completion,
        },
      };
    }

    if (snapshot.status === "draft") {
      return {
        output: {
          task_id: snapshot.id,
          status: "refused",
          error: `task ${snapshot.id} is a draft: atask will not claim an objective missing its proof or `
            + `regression check. Give it both with \`atask update ${snapshot.id} --proof "run: <cmd>" `
            + `--regression "run: <cmd>"\``,
        },
      };
    }

    // A claim whose attempt records no worktree cannot be attached to, and its token was never
    // printed, so nobody can release it: its lease is the only thing that frees the task. atask
    // grants such a claim the short claim window, so wait it out and claim the task rather than
    // refusing one that becomes claimable moments later. A live worker still holding the claim is
    // left alone below.
    if (snapshot.status === "claimed" && snapshot.attempt?.workspace === undefined) {
      const recorded = await recordedWorkerJob(worker, snapshot.id);
      if (recorded?.alive !== true) {
        report(`${snapshot.id} is claimed by an attempt with no worktree; waiting for its claim window to lapse`);
        snapshot = await waitOutUnstoredClaim(snapshot, atask, clock, pollMs, signal);
        if (snapshot.status === "claimed" && snapshot.attempt?.workspace === undefined) {
          const until = snapshot.attempt?.lease_expires_ms;
          return {
            output: {
              task_id: snapshot.id,
              status: "refused",
              error: `task ${snapshot.id} is claimed by an attempt that never recorded its worktree, and its claim token was never `
                + `printed, so nothing can release it. That claim lapses${until === undefined ? "" : ` at ${new Date(until).toISOString()}`}; `
                + "call again after it to claim the task fresh.",
            },
          };
        }
      }
    }

    // A lapsed claim (`interrupted`) and a killed proof run (`verification_failed`) are both
    // resumable the same way: while the task's recorded worker lives, this attaches to it and
    // never claims or spawns a second one.
    const resumable = snapshot.status === "ready"
      || snapshot.status === "interrupted"
      || snapshot.status === "verification_failed";
    if (resumable) {
      const recorded = await recordedWorkerJob(worker, snapshot.id);
      if (recorded?.alive === true) {
        const attempt = snapshot.attempt;
        if (attempt?.workspace === undefined) {
          return {
            output: {
              task_id: snapshot.id,
              status: "refused",
              error: `task ${snapshot.id} has a live worker but its attempt records no worktree; wait for `
                + `that worker to settle, or release the claim to restart it`,
            },
          };
        }
        return {
          resolved: {
            taskId: snapshot.id,
            input: named,
            run: {
              kind: "start",
              token: attempt.token ?? "",
              workspace: attempt.workspace,
              branch: attempt.branch ?? `atask/${snapshot.id}`,
              job_id: recorded.job_id,
            },
            target: snapshot.project === undefined ? undefined : await atask.projectTarget(snapshot.project),
          },
        };
      }
      report(`claiming ${snapshot.id}`);
      let claim: ClaimedTask;
      try {
        claim = await atask.claim(id);
      } catch (error) {
        signal?.throwIfAborted();
        return { output: { task_id: snapshot.id, status: "refused", error: messageOf(error) } };
      }
      const started = await startOrAttach({ ...claim, id: snapshot.id }, named, worker, workerConfig, report);
      if ("failure" in started) return { output: started.failure };
      return { resolved: { taskId: snapshot.id, input: named, run: started.run, target: claim.target_branch } };
    }

    if (snapshot.status === "claimed") {
      const attempt = snapshot.attempt;
      if (attempt?.workspace === undefined) {
        return {
          output: {
            task_id: snapshot.id,
            status: "refused",
            error: `task ${snapshot.id} is claimed but its attempt records no worktree, and a live worker `
              + `holds that claim; wait for that worker to settle`,
          },
        };
      }
      const branch = attempt.branch ?? `atask/${snapshot.id}`;
      // The recorded worker decides: alive means attach, dead means the completion gate will name it
      // with its last output. Only a worker no record can see is waited on blindly — and a blind
      // wait never answers running.
      const recorded = await recordedWorkerJob(worker, snapshot.id);
      const run: Run = recorded === undefined
        ? { kind: "attach", token: attempt.token ?? "", workspace: attempt.workspace, branch }
        : { kind: "start", token: attempt.token ?? "", workspace: attempt.workspace, branch, job_id: recorded.job_id };
      return {
        resolved: {
          taskId: snapshot.id,
          input: named,
          run,
          target: snapshot.project === undefined ? undefined : await atask.projectTarget(snapshot.project),
        },
      };
    }

    return {
      output: {
        task_id: snapshot.id,
        status: "refused",
        error:
          `task ${snapshot.id} is ${snapshot.status}; this starts ready, interrupted and verification_failed tasks and attaches to claimed ones`,
      },
    };
  }
}
