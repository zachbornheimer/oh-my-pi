import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ataskRunnerIn, CLAIM_TIMEOUT_MS } from "./atask_cli.js";
import { diskWorkerPort } from "./disk_worker.js";
import { cliStartTaskAtask, liveLandingPorts } from "./ports.js";
import { createTool } from "./tool.js";

/** The overlay the worker loads next to its pinned model, used only when it exists. */
const WORKER_OVERLAY = join(homedir(), ".omp", "agent", "overlays", "pin-model.yml");

const factory: CustomToolFactory = (pi) => {
  // One worker port for the process: it holds the record of workers this process started.
  const worker = diskWorkerPort();
  const atask = ataskRunnerIn(pi.cwd);
  return createTool(pi, {
    forCall: (signal) => ({
      atask: cliStartTaskAtask(atask, CLAIM_TIMEOUT_MS, signal),
      worker,
      ...liveLandingPorts(signal),
      ...(existsSync(WORKER_OVERLAY) ? { workerConfig: WORKER_OVERLAY } : {}),
    }),
  });
};

export default factory;
