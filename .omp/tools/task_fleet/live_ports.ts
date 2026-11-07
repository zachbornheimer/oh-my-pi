import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERVISOR_SCRIPT } from "./compose.js";
import type { FleetPorts } from "./fleet.js";

/**
 * Where fleets live: `TASK_FLEET_HOME`, else `omp-task-fleet` under the temp directory. Fleet state is process
 * state, like a background job's log: children do not outlive a reboot, and the temp directory is writable
 * where a sandbox refuses writes under the home directory.
 */
export function fleetHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TASK_FLEET_HOME ?? join(tmpdir(), "omp-task-fleet");
}

/** The real host: the detached `xargs -P` supervisor and SIGTERM on the recorded pid. */
export function livePorts(options: { cwd: string; home?: string; defaultSession?: string }): FleetPorts {
  return {
    home: options.home ?? fleetHome(),
    defaultSession: options.defaultSession ?? `process-${process.pid}`,
    cwd: options.cwd,
    now: () => new Date(),
    randomId: () => randomUUID().replaceAll("-", ""),
    startSupervisor({ batchFile, runnerPath, concurrency, cwd }) {
      const supervisor = spawn("/bin/sh", [
        "-c",
        SUPERVISOR_SCRIPT,
        "task-fleet",
        batchFile,
        String(concurrency),
        runnerPath,
      ], { cwd, detached: true, stdio: "ignore" });
      supervisor.on("error", () => undefined);
      supervisor.unref();
    },
    terminate: (pid) => {
      process.kill(pid, "SIGTERM");
    },
  };
}
