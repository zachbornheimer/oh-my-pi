import { isSettledTaskStatus } from "./atask.js";
import {
  completeObjective,
  land,
  POLL_MS,
  recordedWorkerJob,
  recordWorkerJob,
  renewNearExpiry,
  stopWhenSettled,
  WORKER_GRACE_S,
  workerCommand,
} from "./lifecycle.js";
import {
  cliGroupAtask,
  type GhPort,
  type GitPort,
  type GroupAtaskPort,
  type GroupClaim,
  liveLandingPorts,
  type TaskSnapshot,
  workspaceOnDisk,
  type WtPort,
} from "./ports.js";
import type { GroupInput } from "./types.js";
import { type Clock, messageOf, systemClock } from "./util.js";
import { diskWorkerPort, type WorkerPort } from "./worker.js";

/**
 * The claim loop of one group run: fill free slots with `atask claim --group`, run one headless
 * worker per claim in its task worktree, gate each exited worker with `atask verify complete`,
 * run the group's own proofs when atask says they are pending, and, only after atask answers
 * DONE, land the members one at a time in the order they completed. Pure against its ports; the
 * live wiring is the defaults below, and the runner turns the result into the one final report.
 */

/** How one member ended up, as the report names it. */
export type MemberState =
  | "merged"
  | "pull_request"
  | "left"
  | "landing_failed"
  /** Complete and verified, but not landed: the run stalled or failed first. */
  | "complete"
  /** Its worker ended and atask's completion gate refused it; atask's attempts decide what happens next. */
  | "gate_failed";

export interface MemberResult {
  readonly id: string;
  readonly title: string;
  readonly state: MemberState;
  /** The pull request opened for it, when onComplete is pr. */
  readonly url?: string;
  /** The gate's or the landing's failure, in atask's or wt's words. */
  readonly error?: string;
}

export type GroupRunResult =
  | { readonly status: "settled"; readonly group: string; readonly members: readonly MemberResult[] }
  | {
    readonly status: "stalled";
    readonly group: string;
    readonly members: readonly MemberResult[];
    readonly reasons: readonly string[];
  }
  | {
    readonly status: "failed";
    readonly group: string;
    readonly members: readonly MemberResult[];
    readonly error: string;
  };

export interface GroupRunDependencies {
  readonly atask?: GroupAtaskPort;
  readonly worker?: WorkerPort;
  readonly wt?: WtPort;
  readonly git?: GitPort;
  readonly gh?: GhPort;
  readonly clock?: Clock;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  /** Whether a member worktree is still on disk; tests script it, the live landing reads the filesystem. */
  readonly workspaceExists?: (path: string) => Promise<boolean>;
  /** One progress line per notable step (claims, workers, gates, proofs, landings); the runner appends them to its log. */
  readonly log?: (line: string) => void;
  /** The worker command's `--config` overlay: undefined picks the pin-model overlay when it exists, null passes none. */
  readonly workerConfig?: string | null;
}

/** The lander name a pull request body carries. */
const LANDER = "complete_atask_group";

interface RunningMember {
  readonly id: string;
  readonly title: string;
  readonly token: string;
  readonly workspace: string;
  readonly branch: string;
  readonly target?: string;
  readonly job_id: string;
}

/** A member atask shows complete. `job_id` is set when a worker this run started did the work. */
interface FinishedMember {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly branch: string;
  readonly target?: string;
  readonly job_id?: string;
  readonly snapshot: TaskSnapshot;
}

/** What the run does with a claim it gives back: the note atask records on the release. */
const GATE_FAILED_NOTE = "released by complete_atask_group: the completion gate did not pass";
const RUN_ENDED_NOTE = "released by complete_atask_group: the group run ended before this task completed";

interface GroupPorts {
  readonly atask: GroupAtaskPort;
  readonly worker: WorkerPort;
  readonly wt: WtPort;
  readonly git: GitPort;
  readonly gh: GhPort;
  readonly clock: Clock;
  readonly pollMs: number;
  readonly signal?: AbortSignal;
  readonly workspaceExists: (path: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  readonly workerConfig: string | null | undefined;
}

async function resolvePorts(dependencies: GroupRunDependencies): Promise<GroupPorts> {
  const live = dependencies.wt === undefined || dependencies.git === undefined || dependencies.gh === undefined
    ? liveLandingPorts()
    : undefined;
  return {
    atask: dependencies.atask ?? cliGroupAtask(),
    worker: dependencies.worker ?? diskWorkerPort(),
    wt: dependencies.wt ?? live!.wt,
    git: dependencies.git ?? live!.git,
    gh: dependencies.gh ?? live!.gh,
    clock: dependencies.clock ?? systemClock,
    pollMs: dependencies.pollMs ?? POLL_MS,
    signal: dependencies.signal,
    workspaceExists: dependencies.workspaceExists ?? workspaceOnDisk,
    log: dependencies.log ?? (() => undefined),
    workerConfig: dependencies.workerConfig,
  };
}

/**
 * Runs one group to the end and answers how it ended; never throws. A failure the loop cannot
 * answer for (ports that cannot be set up, a worker that will not start, an atask call that errors)
 * stops the workers, releases the claims still held, and answers `failed` with the cause.
 */
export async function runAtaskGroup(
  input: GroupInput,
  dependencies: GroupRunDependencies = {},
): Promise<GroupRunResult> {
  let ports: GroupPorts;
  try {
    ports = await resolvePorts(dependencies);
  } catch (error) {
    return { status: "failed", group: input.group, members: [], error: messageOf(error) };
  }
  return driveGroup(input, ports);
}

async function driveGroup(input: GroupInput, ports: GroupPorts): Promise<GroupRunResult> {
  const { atask, worker, wt, git, gh, clock, pollMs, signal, workspaceExists, log } = ports;

  /** Members whose worker this run started and whose claim it holds, gating ones included. */
  const running = new Map<string, RunningMember>();
  /** The gates in flight, by member. A gating member keeps its slot and claim until its gate answers. */
  const gating = new Map<string, Promise<void>>();
  /** Complete members whose worker this run started, in the order they completed. */
  const finished: FinishedMember[] = [];
  /** The last gate failure per member that has not completed since. */
  const gateFailures = new Map<string, { title: string; error: string }>();
  /** The members to land, once atask has answered DONE; includes members an earlier run completed. */
  let landing: readonly FinishedMember[] | undefined;
  const landed = new Map<string, MemberResult>();
  /** An error a background gate could not answer for; the loop throws it on its next pass. */
  let gateCrash: { readonly error: unknown } | undefined;

  const membersSoFar = (): MemberResult[] => {
    const members = landing ?? finished;
    return [
      ...members.map((member) =>
        landed.get(member.id) ?? { id: member.id, title: member.title, state: "complete" as const }
      ),
      ...[...gateFailures]
        .filter(([id]) => !members.some((member) => member.id === id))
        .map(([id, failure]) => ({ id, title: failure.title, state: "gate_failed" as const, error: failure.error })),
    ];
  };

  /** Gives a claim back; a release that fails is left to the claim's own lease expiry. */
  async function releaseClaim(token: string, failed: boolean, note: string): Promise<void> {
    try {
      await atask.release(token, failed, note);
    } catch {
      // the lease expiry returns the task if this release fails
    }
  }

  /** The member record the run tracks for a claim, watching the given worker job. */
  const memberOf =
    (claim: Extract<GroupClaim, { kind: "claimed" }>["claim"], job_id: string): RunningMember => ({
      id: claim.id,
      title: claim.title ?? claim.id,
      token: claim.token,
      workspace: claim.workspace,
      branch: claim.branch,
      ...(claim.target_branch === undefined ? {} : { target: claim.target_branch }),
      job_id,
    });

  async function startOrAttach(claim: Extract<GroupClaim, { kind: "claimed" }>["claim"]): Promise<void> {
    // A re-claimed member can already have a live worker: its lease lapsed, not its process.
    // While that worker lives the run adopts it, never giving the task a second worker.
    const recorded = await recordedWorkerJob(worker, claim.id);
    if (recorded?.alive === true) {
      log(`${claim.id}: adopted the live worker ${recorded.job_id}`);
      running.set(claim.id, memberOf(claim, recorded.job_id));
      return;
    }
    let job: { job_id: string };
    try {
      job = await worker.start({
        command: workerCommand({ id: claim.id, add_dirs: input.add_dirs }, ports.workerConfig),
        cwd: claim.workspace,
        taskId: claim.id,
        timeoutSeconds: input.worker_timeout_s + WORKER_GRACE_S,
      });
    } catch (error) {
      await releaseClaim(claim.token, false, RUN_ENDED_NOTE);
      throw error;
    }
    recordWorkerJob(worker, claim.id, job.job_id);
    log(`${claim.id}: started worker ${job.job_id} in ${claim.workspace}`);
    running.set(claim.id, memberOf(claim, job.job_id));
  }

  /**
   * Runs the completion gate of a member whose worker exited, in the background: a gate runs a whole
   * check suite (up to 20 minutes) and must not stop the loop from renewing every other claim. A
   * gate that fails gives the claim back as a failed attempt, so atask hands the task to a fresh worker.
   */
  function startGate(member: RunningMember, job: { readonly output_tail?: string }): void {
    log(`${member.id}: worker ended, running the completion gate`);
    const gate = (async () => {
      const gated = await completeObjective(member.id, member, job, atask);
      if (gated.kind === "settled") {
        log(`${member.id}: gate passed`);
        gateFailures.delete(member.id);
        finished.push({ ...member, snapshot: gated.snapshot });
      } else {
        log(`${member.id}: gate failed`);
        gateFailures.set(member.id, { title: member.title, error: gated.error });
        await releaseClaim(member.token, true, GATE_FAILED_NOTE);
      }
      running.delete(member.id);
    })()
      .catch((error: unknown) => {
        gateCrash ??= { error };
      })
      .finally(() => gating.delete(member.id));
    gating.set(member.id, gate);
  }

  async function reapMember(member: RunningMember): Promise<void> {
    let snapshot: TaskSnapshot | undefined;
    try {
      snapshot = await atask.show(member.id);
    } catch {
      snapshot = undefined; // this round's state is unknown; the worker's decides below
    }
    if (snapshot !== undefined && isSettledTaskStatus(snapshot.status)) {
      log(`${member.id}: complete`);
      running.delete(member.id);
      gateFailures.delete(member.id);
      finished.push({ ...member, snapshot });
      return;
    }
    const job = await worker.status(member.job_id);
    if (job.state === "running") {
      await renewNearExpiry(snapshot, member.token, atask, clock);
      return;
    }
    // The worker ended without atask seeing the task complete: only atask's own gate can settle it.
    startGate(member, job);
  }

  /**
   * Polls every running member that is not mid-gate: moves the ones atask settled to `finished`,
   * renews the leases of the live ones, and starts the gate of the ones whose worker exited.
   * `finished` is in the order the members actually completed.
   */
  async function reap(): Promise<void> {
    await Promise.all([...running.values()].filter((member) => !gating.has(member.id)).map(reapMember));
    if (gateCrash !== undefined) throw gateCrash.error;
  }

  /**
   * Lands the complete members one at a time in completion order. The members come from atask's
   * own view of the group, so ones an earlier run completed land too.
   */
  async function landAll(): Promise<MemberResult[]> {
    const jobs = new Map(finished.map((member) => [member.id, member.job_id]));
    landing = (await atask.completedMembers(input.group)).map((member) => ({
      id: member.id,
      title: member.title,
      workspace: member.workspace,
      branch: member.branch,
      ...(member.target_branch === undefined ? {} : { target: member.target_branch }),
      ...(jobs.get(member.id) === undefined ? {} : { job_id: jobs.get(member.id) }),
      snapshot: member.snapshot,
    }));
    log(`atask answered DONE: landing ${landing.length} member(s) with onComplete ${input.onComplete}`);
    for (const member of landing) {
      if (member.job_id !== undefined) await stopWhenSettled(member.job_id, worker, clock, signal);
      const completion = await land(
        { onComplete: input.onComplete },
        member.workspace,
        member.branch,
        member.snapshot,
        { wt, git, gh, lander: LANDER, workspaceExists },
        member.target,
      );
      log(`${member.id}: landing ${completion.outcome}`);
      landed.set(member.id, {
        id: member.id,
        title: member.title,
        state: completion.outcome === "failed" ? "landing_failed" : completion.outcome,
        ...(completion.url === undefined ? {} : { url: completion.url }),
        ...(completion.error === undefined ? {} : { error: completion.error }),
      });
    }
    return membersSoFar();
  }

  /**
   * Ends the run's hold on everything it started: lets the gates in flight answer, stops every
   * worker, and gives back the claims still held. A member that completed keeps its completion.
   */
  async function windDown(): Promise<void> {
    await Promise.allSettled(gating.values());
    for (const member of running.values()) {
      worker.stop(member.job_id);
      await releaseClaim(member.token, false, RUN_ENDED_NOTE);
    }
    for (const member of finished) {
      if (member.job_id !== undefined) worker.stop(member.job_id);
    }
  }

  let proofsTriedFor: string | undefined;
  let proofsError: string | undefined;

  try {
    for (;;) {
      signal?.throwIfAborted();
      await reap();

      let outcome: Exclude<GroupClaim, { kind: "claimed" }> | undefined;
      while (running.size < input.max_workers) {
        signal?.throwIfAborted(); // a stop request must never claim another member
        const next = await atask.claimGroup(input.group);
        if (next.kind !== "claimed") {
          outcome = next;
          break;
        }
        log(`claimed ${next.claim.id}`);
        await startOrAttach(next.claim);
      }

      if (outcome?.kind === "done" && running.size === 0) {
        return { status: "settled", group: input.group, members: await landAll() };
      }
      if (outcome?.kind === "stalled" && running.size === 0) {
        const members = membersSoFar();
        log(`stalled: ${outcome.reasons.join("; ")}`);
        await windDown();
        return { status: "stalled", group: input.group, members, reasons: outcome.reasons };
      }
      if (outcome?.kind === "not_ready" && outcome.proofsPending) {
        // Run the group's proofs once per pending state; the same state again means they did not pass.
        const state = finished.map((member) => member.id).join(",");
        if (proofsTriedFor !== state) {
          proofsTriedFor = state;
          proofsError = undefined;
          log(`running the group's own proofs`);
          try {
            await atask.verifyGroup(input.group);
          } catch (error) {
            proofsError = messageOf(error);
          }
          continue;
        }
        if (proofsError !== undefined) {
          throw new Error(`the proofs of group ${input.group} did not pass: ${proofsError}`);
        }
      }

      await clock.sleep(pollMs, signal);
    }
  } catch (error) {
    await windDown();
    return { status: "failed", group: input.group, members: membersSoFar(), error: messageOf(error) };
  }
}
