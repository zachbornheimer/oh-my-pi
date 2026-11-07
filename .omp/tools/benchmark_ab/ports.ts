import { type ChildProcessByStdio, type SpawnOptionsWithStdioTuple, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { access, constants, readFile, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

/**
 * The machine seam of benchmark_ab: a runner that executes one command, the monotonic clock the orchestration reads
 * around it, and the store that keeps a spec file. Tests inject all three; production builds them here.
 */

/** One execution request: the spec already resolved cwd, env and the deadline. */
export interface TimedRunRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** What one run did. The caller owns the timing; the runner only executes. */
export interface TimedRunOutcome {
  /** The exit code, or null when the process never started or was ended by a signal. */
  readonly exitCode: number | null;
  /** True when the deadline killed the process. */
  readonly timedOut: boolean;
  /** True when the process never started; the output carries the spawn error. */
  readonly couldNotStart: boolean;
  /** The signal that ended the process, when one did and it was not the deadline. */
  readonly signal?: string;
  /** The last bytes of the output, for the reason a failed run stopped the benchmark. */
  readonly output: string;
}

export interface BenchRunner {
  run(request: TimedRunRequest): Promise<TimedRunOutcome>;
}

/** The spec store: raw JSON text at a path; parsing stays with the orchestration. */
export interface SpecStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Whether a file exists at the path. */
  exists(path: string): Promise<boolean>;
}

/** The tail kept from a run's output: enough to say why a benchmark stopped, never a full log. */
const OUTPUT_TAIL_BYTES = 2000;

/** The preferred login shell, and the POSIX one used when it is not executable here. */
export const PREFERRED_SHELL = "/bin/bash";
export const POSIX_SHELL = "/bin/sh";

/** `bash -lc` when bash is executable here; otherwise `/bin/sh -c`: the login flag is not POSIX. */
export function shellPlan(bashExecutable: boolean): { shell: string; args: string[] } {
  return bashExecutable ? { shell: PREFERRED_SHELL, args: ["-lc"] } : { shell: POSIX_SHELL, args: ["-c"] };
}

/** True only when the path exists and is a directory; a missing path or a file is false. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The refusal for a command whose working directory cannot be used: it names the path and the recovery. */
export function missingWorkingDirectoryReason(cwd: string): string {
  return `refused: working directory ${cwd} does not exist. Pass an existing absolute cwd; nothing was run.`;
}

/** Runs each command under the preferred shell in its own process group; the deadline and the abort signal kill the whole group. */
export function shellRunner(): BenchRunner {
  return { run: (request) => spawnUnderShell(request) };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

type ShellSpawnOptions = SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">;

/** Starts `command` under one of the two shells `shellPlan` can choose; any other shell is refused. */
function startShell(
  plan: { shell: string; args: string[] },
  command: string,
  options: ShellSpawnOptions,
): ChildProcessByStdio<null, Readable, Readable> {
  switch (plan.shell) {
    case "/bin/bash":
      return spawn("/bin/bash", [...plan.args, command], options);
    case "/bin/sh":
      return spawn("/bin/sh", [...plan.args, command], options);
    default:
      throw new Error(`refusing to run under shell "${plan.shell}": not ${PREFERRED_SHELL} or ${POSIX_SHELL}`);
  }
}

async function spawnUnderShell(request: TimedRunRequest): Promise<TimedRunOutcome> {
  request.signal?.throwIfAborted();
  const plan = shellPlan(await isExecutableFile(PREFERRED_SHELL));
  const { promise, resolve, reject } = Promise.withResolvers<TimedRunOutcome>();
  const spawnOptions: ShellSpawnOptions = {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  };
  const child = startShell(plan, request.command, spawnOptions);
  let output = "";
  let timedOut = false;
  let settled = false;
  const append = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES * 2);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const onAbort = (): void => {
    killGroup(child.pid);
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    reject(request.signal!.reason ?? new Error("benchmark aborted"));
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, request.timeoutMs);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  const finish = (outcome: TimedRunOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", onAbort);
    resolve(outcome);
  };
  child.on("error", (error) => finish({ exitCode: null, timedOut: false, couldNotStart: true, output: error.message }));
  child.on("close", (code, signal) => {
    finish({
      exitCode: code,
      timedOut,
      couldNotStart: false,
      ...(signal !== null && !timedOut ? { signal } : {}),
      output: output.slice(-OUTPUT_TAIL_BYTES),
    });
  });
  return promise;
}

/** The monotonic clock production times with. */
export function performanceClock(): () => number {
  return () => performance.now();
}

/** Reads and writes spec files as UTF-8 text. */
export function fileSpecStore(): SpecStore {
  return {
    read: (path) => readFile(path, "utf8"),
    write: (path, content) => writeFile(path, content, "utf8"),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
