import { shQuote } from "./text.js";

/**
 * The background-worker port: one detached shell job per worker, started in a directory and
 * watched through state on disk, so a later call (or a later omp process) can find a run it never
 * started. The live implementations are in `disk_worker.ts`.
 */

/** The marker the worker script appends to its log when the command ends: `__exit__<code>`. */
export const EXIT_MARKER = "__exit__";

/** One worker spawn request: the shell command, the directory it runs in, and its kill timeout. */
export interface WorkerSpawnRequest {
  readonly command: string;
  readonly cwd?: string;
  /** The task the worker runs, so a later call can find the run. */
  readonly taskId?: string;
  readonly timeoutSeconds: number;
}

/** How a spawned worker reports itself. */
export interface WorkerSpawnStatus {
  readonly state: "running" | "exited" | "killed" | "timed_out" | "unknown";
  readonly exit_code?: number;
  readonly output_tail?: string;
}

/** The background jobs the lifecycle starts and watches. */
export interface WorkerPort {
  start(request: WorkerSpawnRequest): Promise<{ job_id: string }>;
  status(jobId: string): Promise<WorkerSpawnStatus>;
  /** Stops one job; a known id reports `killed`, even when it had already stopped. */
  stop(jobId: string): "killed" | "unknown";
  /** The newest job id recorded for a task, so a later call attaches instead of starting a second worker. */
  find?(taskId: string): Promise<string | undefined>;
}

/**
 * The `sh` script a worker runs. The kill budget is enforced inside the script (so nothing in the
 * calling process has to stay alive to stop it) by `timeout`, else `gtimeout`, else a perl alarm;
 * with none of them the command is not run and the log says why. The command's output is tee'd to
 * the log (`tee`, for a visible pane) or appended to it (`file`); then `__exit__<code>` is appended,
 * and `after` (for example closing the pane) runs last.
 */
export function workerScript(options: {
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly logPath: string;
  readonly output: "tee" | "file";
  readonly after?: string;
}): string {
  const log = shQuote(options.logPath);
  const lines = [
    `LOG=${log}`,
    `CMD=${shQuote(options.command)}`,
    `N=${Math.max(1, Math.floor(options.timeoutSeconds))}`,
    `if command -v timeout >/dev/null 2>&1; then set -- timeout "$N"`,
    `elif command -v gtimeout >/dev/null 2>&1; then set -- gtimeout "$N"`,
    `elif command -v perl >/dev/null 2>&1; then set -- perl -e 'alarm shift; exec @ARGV' "$N"`,
    `else set --; fi`,
    `run() {`,
    `  if [ "$#" -eq 0 ]; then echo "worker not started: none of timeout, gtimeout or perl is available to enforce the ${options.timeoutSeconds}s budget"; return 127; fi`,
    `  "$@" sh -c "$CMD"`,
    `}`,
  ];
  if (options.output === "tee") {
    lines.push(
      `C=$(mktemp)`,
      `{ run "$@"; echo $? >"$C"; } 2>&1 | tee -a "$LOG"`,
      `code=$(cat "$C"); rm -f "$C"`,
    );
  } else {
    lines.push(`run "$@" >>"$LOG" 2>&1; code=$?`);
  }
  lines.push(`printf '\\n${EXIT_MARKER}%s\\n' "$code" >>"$LOG"`);
  if (options.after !== undefined) lines.push(options.after);
  return `${lines.join("\n")}\n`;
}
