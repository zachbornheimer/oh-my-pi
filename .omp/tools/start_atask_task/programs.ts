import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { abortReason, tailOf } from "./text.js";

/** One landed-work program run: wt, git, or gh. */
export interface ProgramRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not start, for example when it is not installed. */
  readonly spawnError?: string;
}

/** The binaries the landed-work ports run. A closed set. */
export type LandedWorkBinary = "wt" | "git" | "gh";

/** Runs one program with an argv array, so nothing is ever interpreted by a shell. */
export type RunProgram = (
  binary: LandedWorkBinary,
  argv: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ProgramRun>;

/** Starts one of the closed set of binaries; a name outside it is refused, so no caller value can choose what runs. */
function startLandedWorkBinary(binary: LandedWorkBinary, argv: readonly string[], options: SpawnOptions): ChildProcess {
  switch (binary) {
    case "wt":
      return spawn("wt", [...argv], options);
    case "git":
      return spawn("git", [...argv], options);
    case "gh":
      return spawn("gh", [...argv], options);
    default:
      throw new Error(`refusing to run "${String(binary)}": not one of wt, git, gh`);
  }
}

/** Spawns the program; an abort kills it and rejects with the abort reason, a timeout kills it and answers its exit. */
export const runProgram: RunProgram = (binary, argv, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<ProgramRun>();
  const { signal } = options;
  if (signal?.aborted) {
    reject(abortReason(signal));
    return promise;
  }
  const spawnOptions = { cwd: options.cwd, env: process.env, shell: false } as const;
  const child = startLandedWorkBinary(binary, argv, spawnOptions);
  let finished = false;
  const finish = (settle: () => void): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    settle();
  };
  const onAbort = (): void => {
    child.kill("SIGKILL");
    finish(() => reject(abortReason(signal as AbortSignal)));
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => finish(() => resolve({ code: 1, stdout: "", stderr: "", spawnError: error.message })));
  child.on("close", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
  return promise;
};

/** The program's trimmed stdout, or the failure naming what exited and what it printed. */
export function outputOf(run: ProgramRun, what: string): string {
  if (run.spawnError !== undefined) throw new Error(`${what} could not start: ${run.spawnError}`);
  if (run.code !== 0) {
    const printed = tailOf(run.stderr.trim() || run.stdout);
    throw new Error(`${what} exited ${run.code}${printed === "" ? "" : `: ${printed}`}`);
  }
  return run.stdout.trim();
}
