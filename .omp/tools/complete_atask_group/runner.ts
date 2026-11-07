import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type GroupRunDependencies, type GroupRunResult, runAtaskGroup } from "./loop.js";
import { renderReport } from "./render.js";
import { HEARTBEAT_MS, readRecord, readRequest, type RunRecord, writeAtomic, writeRecord } from "./runs.js";
import { LOOP_BUDGET_S } from "./types.js";
import { messageOf } from "./util.js";

/**
 * The detached half of `complete_atask_group`: `bun runner.ts <run dir>`, started by the tool as its own
 * process group so it outlives the tool call. It records `running`, keeps a heartbeat in `status.json`,
 * drives the claim loop to its end, and writes the final record exactly once (settled, stalled or failed)
 * with the rendered report. SIGTERM stops it: workers are stopped, held claims released, and the run is
 * recorded as failed with the stop named.
 */

export interface RunnerOptions {
  /** Ports and tuning for the loop; production uses the live atask, workers and landing programs. */
  readonly loop?: GroupRunDependencies;
  /** Replaces the loop itself; tests use it to make the loop break its own contract. */
  readonly runLoop?: typeof runAtaskGroup;
  readonly heartbeatMs?: number;
  readonly budgetS?: number;
  /** The process id recorded in the status file; defaults to this process. */
  readonly pid?: number;
  readonly now?: () => number;
  /** Aborts the run from outside (the signal handlers in production). */
  readonly stop?: AbortSignal;
}

/** Runs the run in `dir` to its end and returns the final record. Never throws: every failure is recorded as `failed`. */
export async function runGroupRun(dir: string, options: RunnerOptions = {}): Promise<RunRecord> {
  const now = options.now ?? (() => Date.now());
  const request = await readRequest(dir);
  const prior = await readRecord(dir);
  const started_at = prior?.started_at ?? now();
  const base = { run_id: request.run_id, group: request.group, pid: options.pid ?? process.pid, started_at };

  const logLine = (line: string): void => {
    try {
      appendFileSync(join(dir, "runner.log"), `${new Date(now()).toISOString()} ${line}\n`);
    } catch {
      // the log is a convenience; the record is the answer
    }
  };

  let record: RunRecord = { ...base, state: "running", heartbeat_at: now() };
  await writeRecord(dir, record);
  logLine(`run ${request.run_id} started for group ${request.group} (max_workers ${request.max_workers}, onComplete ${request.onComplete})`);

  // Serialised in-process writes: a heartbeat must never land after the final record.
  let writing: Promise<void> = Promise.resolve();
  const beat = setInterval(() => {
    record = { ...record, heartbeat_at: now() };
    writing = writing.then(() => writeRecord(dir, record)).catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  const controller = new AbortController();
  const budget = setTimeout(
    () => controller.abort(new Error(`the run exceeded its ${Math.round((options.budgetS ?? LOOP_BUDGET_S) / 3600)} hour budget`)),
    (options.budgetS ?? LOOP_BUDGET_S) * 1000,
  );
  const forwardStop = (): void => controller.abort(new Error("the run was stopped by request"));
  if (options.stop?.aborted) forwardStop();
  options.stop?.addEventListener("abort", forwardStop, { once: true });

  let result: GroupRunResult;
  try {
    result = await (options.runLoop ?? runAtaskGroup)(request, {
      ...options.loop,
      signal: controller.signal,
      log: logLine,
    });
  } catch (error) {
    // runAtaskGroup answers every failure itself; a throw here is a bug in it, and the record must still go out once.
    result = { status: "failed", group: request.group, members: [], error: messageOf(error) };
  } finally {
    clearInterval(beat);
    clearTimeout(budget);
    options.stop?.removeEventListener("abort", forwardStop);
  }
  await writing;

  const { subject, body } = renderReport(result);
  const final: RunRecord = {
    ...record,
    state: result.status,
    heartbeat_at: now(),
    finished_at: now(),
    result,
    subject,
    report: body,
  };
  await writeAtomic(join(dir, "report.txt"), `${subject}\n${body}\n`);
  await writeRecord(dir, final);
  logLine(subject);
  return final;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined || dir === "") {
    console.error("usage: bun runner.ts <run dir>");
    process.exit(2);
  }
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop.abort());
  try {
    await runGroupRun(dir, { stop: stop.signal });
  } catch (error) {
    // Even a failure while writing the record must leave a trace for the reader.
    console.error(`runner failed: ${messageOf(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) await main();
