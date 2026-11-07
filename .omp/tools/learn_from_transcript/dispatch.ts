import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StartTask } from "./objectives.js";
import { CLAIM_TIMEOUT_MS, ataskRunner } from "./start_task/atask_cli.js";
import { diskWorkerPort } from "./start_task/disk_worker.js";
import { startAtaskTask } from "./start_task/lifecycle.js";
import { cliStartTaskAtask, liveLandingPorts } from "./start_task/ports.js";

/** The overlay the worker loads next to its pinned model, used only when it exists. */
const WORKER_OVERLAY = join(homedir(), ".omp", "agent", "overlays", "pin-model.yml");

/** One worker port for the process: it holds the record of workers this process started, so a repeat call attaches. */
const worker = diskWorkerPort();

/**
 * The worker run the learn chain dispatches through: the `start_atask_task` lifecycle (claim, headless `omp` worker in the
 * task worktree, `atask verify complete`, landing per `onComplete`) against the real `atask`, `wt`, `git` and `gh`
 * binaries. Each call waits at most the input's `timeout_s` (default 1800 s) and answers `running` after that; a repeat
 * call attaches to the live worker. An aborted `signal` stops the wait, not the worker.
 */
export function liveStartTask(options: {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly report?: (message: string) => void;
}): StartTask {
  const atask = ataskRunner(options.cwd);
  return (input) =>
    startAtaskTask(input, {
      atask: cliStartTaskAtask(atask, CLAIM_TIMEOUT_MS, options.signal),
      worker,
      ...liveLandingPorts(options.signal),
      signal: options.signal,
      ...(options.report === undefined ? {} : { report: options.report }),
      ...(existsSync(WORKER_OVERLAY) ? { workerConfig: WORKER_OVERLAY } : {}),
    });
}
