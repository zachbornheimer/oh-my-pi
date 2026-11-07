import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliGroupAtask, type GroupAtaskPort, type GroupInspection } from "./ports.js";
import {
  activeRunOf,
  createRunDir,
  describeRun,
  isTerminal,
  type Liveness,
  liveLiveness,
  logTail,
  newRunId,
  observe,
  readRecord,
  type RunRecord,
  runDirOf,
  writeRecord,
} from "./runs.js";
import type { GroupDraft, GroupInput, GroupRunRequest } from "./types.js";
import { isExecutableFile, messageOf } from "./util.js";
import { defaultStateRoot } from "./worker.js";

/**
 * The foreground half of `complete_atask_group`: check the group is worth running, start the detached
 * runner (`runner.ts`), and answer at once. The runner is its own process group, so it outlives this
 * call; its record under the state root is what a later call reads.
 */

/** How long the start waits for the runner to record that it is up before reporting the start failed. */
const RUNNER_UP_MS = 15_000;

export type StartOutcome =
  | {
    readonly status: "started" | "running";
    readonly group: string;
    readonly run_id: string;
    readonly run_dir: string;
  }
  | { readonly status: "refused"; readonly group: string; readonly error: string; readonly drafts?: readonly GroupDraft[] };

export interface StartGroupDependencies {
  readonly atask?: Pick<GroupAtaskPort, "inspect">;
  /** Starts the detached runner for a prepared run directory and answers its pid; production spawns `bun runner.ts`. */
  readonly spawnRunner?: (runDir: string) => Promise<{ readonly pid: number }>;
  readonly stateRoot?: string;
  readonly newRunId?: () => string;
  readonly liveness?: Liveness;
  /** How long to wait for the runner to come up; tests shorten it. */
  readonly upTimeoutMs?: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  /** Stops a runner that never came up; production sends SIGTERM. */
  readonly kill?: (pid: number) => void;
}

function draftsMessage(inspection: Extract<GroupInspection, { kind: "group" }>): string {
  const named = inspection.drafts
    .map((draft) =>
      `${draft.id} ${draft.title}${draft.missing.length === 0 ? "" : ` (missing ${draft.missing.join(" and ")})`}`
    )
    .join("; ");
  return `group ${inspection.id} holds ${inspection.drafts.length} draft member(s) atask will not claim: ${named}. `
    + "Give each its proof and regression with `atask update <id> --proof ... --regression ...`, then call again";
}

/** The bun that runs the runner: this process when it is bun, else the first bun on PATH. */
export async function resolveBun(): Promise<string | undefined> {
  if (basename(process.execPath).toLowerCase() === "bun") return process.execPath;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "bun");
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

const RUNNER_PATH = fileURLToPath(new URL("./runner.ts", import.meta.url));

/** Spawns `bun runner.ts <dir>` as its own process group, its output going to `runner.log`. */
export function spawnBunRunner(cwd: string | undefined): (runDir: string) => Promise<{ readonly pid: number }> {
  return async (runDir) => {
    const bun = await resolveBun();
    if (bun === undefined) throw new Error("bun is not on PATH, and the detached runner needs it");
    const log = openSync(join(runDir, "runner.log"), "a");
    try {
      // The program is always the literal `bun`; the resolved build is pinned by putting its directory first on PATH.
      const child = spawn("bun", [RUNNER_PATH, runDir], {
        cwd,
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ""}` },
      });
      const started = Promise.withResolvers<void>();
      child.once("spawn", () => started.resolve());
      child.once("error", (error) => started.reject(error));
      await started.promise;
      child.unref();
      if (child.pid === undefined) throw new Error("the runner has no pid");
      return { pid: child.pid };
    } finally {
      closeSync(log);
    }
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const stop = (): void => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", stop);
    resolve();
  }, ms);
  signal?.addEventListener("abort", stop, { once: true });
  return promise;
}

export async function startGroupRun(input: GroupInput, dependencies: StartGroupDependencies = {}): Promise<StartOutcome> {
  const atask = dependencies.atask ?? cliGroupAtask();
  const stateRoot = dependencies.stateRoot ?? defaultStateRoot();
  const liveness = dependencies.liveness ?? liveLiveness;
  const refused = (error: string, extra: { drafts?: readonly GroupDraft[] } = {}): StartOutcome => ({
    status: "refused",
    group: input.group,
    error,
    ...extra,
  });

  let inspection: GroupInspection;
  try {
    inspection = await atask.inspect(input.group);
  } catch (error) {
    return refused(messageOf(error));
  }
  if (inspection.kind === "not_group") {
    return refused(
      `${inspection.id} is a ${inspection.actual}, not a group; pass a group id, or use start_atask_task for one task`,
    );
  }
  if (inspection.members === 0) return refused(`group ${inspection.id} has no members to run`);
  if (inspection.drafts.length > 0) return refused(draftsMessage(inspection), { drafts: [...inspection.drafts] });

  const existing = await activeRunOf(stateRoot, inspection.id, liveness);
  if (existing !== undefined) {
    return {
      status: "running",
      group: inspection.id,
      run_id: existing.run_id,
      run_dir: runDirOf(stateRoot, existing.run_id),
    };
  }

  const request: GroupRunRequest = {
    ...input,
    group: inspection.id,
    run_id: (dependencies.newRunId ?? newRunId)(),
  };
  const dir = await createRunDir(stateRoot, request);
  const began = liveness.now();
  // The runner replaces this record with its own (running, with its pid) as soon as it is up.
  await writeRecord(dir, {
    run_id: request.run_id,
    group: request.group,
    state: "starting",
    started_at: began,
    heartbeat_at: began,
  });
  const spawnRunner = dependencies.spawnRunner ?? spawnBunRunner(dependencies.cwd);
  let pid: number;
  try {
    ({ pid } = await spawnRunner(dir));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    return refused(`the runner could not start: ${messageOf(error)}`);
  }

  // The runner records `running` within a moment; a runner that dies on its way up is a failed start, not a started run.
  const deadline = Date.now() + (dependencies.upTimeoutMs ?? RUNNER_UP_MS);
  for (;;) {
    const record = await readRecord(dir);
    if (record !== undefined && record.state !== "starting") {
      if (record.state === "running" || isTerminal(record.state)) break;
    }
    if (!liveness.alive(pid) || Date.now() > deadline) {
      const alive = liveness.alive(pid);
      if (alive) {
        try {
          (dependencies.kill ?? ((target) => process.kill(target, "SIGTERM")))(pid);
        } catch {
          // already gone
        }
      }
      const tail = await logTail(dir);
      const reason = `the runner did not come up (${alive ? "no heartbeat within the start window" : "it exited"})`;
      // A failed start must not leave a `starting` record behind: it would block the next start of this group.
      const stamp = liveness.now();
      await writeRecord(dir, {
        run_id: request.run_id,
        group: request.group,
        state: "failed",
        started_at: began,
        heartbeat_at: stamp,
        finished_at: stamp,
        subject: `group ${request.group} failed: ${reason}`,
        report: tail,
      });
      return refused(`${reason}${tail === "" ? "" : `: ${tail}`}. Run state is in ${dir}`);
    }
    await sleep(dependencies.pollMs ?? 100, dependencies.signal);
  }
  return { status: "started", group: request.group, run_id: request.run_id, run_dir: dir };
}

export interface PollOutcome {
  readonly record: RunRecord;
  readonly text: string;
  readonly run_dir: string;
}

/** Reads a run's record, observed against its runner's liveness. Throws when the run id names no run. */
export async function pollRun(
  runId: string,
  options: { readonly stateRoot?: string; readonly liveness?: Liveness } = {},
): Promise<PollOutcome> {
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const liveness = options.liveness ?? liveLiveness;
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`run_id ${runId} is not a run id`);
  const dir = runDirOf(stateRoot, runId);
  const record = await readRecord(dir);
  if (record === undefined) throw new Error(`no run ${runId} under ${stateRoot}`);
  const seen = observe(record, liveness);
  return { record: seen, text: describeRun(seen, await logTail(dir), liveness), run_dir: dir };
}

/** Asks a live runner to stop: workers stopped, held claims released, the run recorded as failed with the stop named. */
export async function stopRun(
  runId: string,
  options: { readonly stateRoot?: string; readonly liveness?: Liveness; readonly kill?: (pid: number) => void } = {},
): Promise<PollOutcome & { readonly stopRequested: boolean }> {
  const polled = await pollRun(runId, options);
  const { record } = polled;
  if (isTerminal(record.state) || record.pid === undefined) {
    return { ...polled, stopRequested: false };
  }
  try {
    (options.kill ?? ((pid) => process.kill(pid, "SIGTERM")))(record.pid);
  } catch (error) {
    throw new Error(`could not signal runner ${record.pid} of run ${runId}: ${messageOf(error)}`);
  }
  return {
    ...polled,
    stopRequested: true,
    text: `stop requested for run ${runId} (SIGTERM to runner ${record.pid}); poll with run_id for the final record`,
  };
}
