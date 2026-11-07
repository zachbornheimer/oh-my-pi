import { spawn } from "node:child_process";

/** How `Runner` is told to run one process. `env` replaces the child's environment when given. */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** SIGTERM after this long, then SIGKILL after `graceMs`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  graceMs?: number;
}

export interface RunResult {
  /** The exit code; -1 when the process was killed or never reported one. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when the timeout or the abort signal stopped it. */
  killed: boolean;
}

/** Runs one fixed program with an argument array: never through a shell. Tests substitute this. */
export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** The longest stdout this runner keeps; a larger answer is a failure, not a truncation. */
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 10_000;

/** The only programs the real runner starts: the PR tooling, and `node` for the runner's own process tests. */
type AllowedProgram = "git" | "gh" | "omp" | "ocr" | "node";

/** Starts one allowlisted program with an argument array and no shell; any other name throws. */
function startAllowed(program: string, args: readonly string[], options: RunOptions) {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  } as const;
  const name = program as AllowedProgram;
  switch (name) {
    case "git":
      return spawn("git", [...args], spawnOptions);
    case "gh":
      return spawn("gh", [...args], spawnOptions);
    case "omp":
      return spawn("omp", [...args], spawnOptions);
    case "ocr":
      return spawn("ocr", [...args], spawnOptions);
    case "node":
      return spawn("node", [...args], spawnOptions);
    default:
      throw new Error("not a program the runner may start");
  }
}

/** The real runner: `node:child_process.spawn`, no stdin, stdout and stderr captured. */
export function spawnRunner(base: { signal?: AbortSignal } = {}): Runner {
  return (command, args, options = {}) => {
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    const signal = options.signal ?? base.signal;
    if (signal?.aborted) {
      reject(new Error(`${command} was cancelled before it started`));
      return promise;
    }
    let child: ReturnType<typeof startAllowed>;
    try {
      child = startAllowed(command, args, options);
    } catch (error) {
      reject(new Error(`${command} failed to start: ${(error as Error).message}`));
      return promise;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    let overflow = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), options.graceMs ?? DEFAULT_GRACE_MS);
    };
    if (options.timeoutMs !== undefined) termTimer = setTimeout(stop, options.timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = (): void => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS && !overflow) {
        overflow = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000_000);
    });
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (overflow) reject(new Error(`${command} wrote more than ${MAX_OUTPUT_CHARS} characters to stdout`));
      else resolve({ code: code ?? -1, stdout, stderr, killed });
    });
    return promise;
  };
}

/** Waits `ms`; rejects at once when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new Error("cancelled"));
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Error("cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/**
 * Runs a program and returns its stdout, or throws. The message is `Command failed: <program and first three
 * arguments>` and then the tail of stderr (else stdout), so a caller can classify the failure by what the program said.
 */
export async function command(
  run: Runner,
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const label = `${program} ${args.slice(0, 3).join(" ")}`.trim();
  const result = await run(program, args, options);
  if (result.killed) {
    throw new Error(
      options.signal?.aborted === true
        ? `${label} was cancelled`
        : `Command failed: ${label}\ntimed out after ${options.timeoutMs ?? "?"} ms`,
    );
  }
  if (result.code !== 0) {
    const said = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(-8_000);
    throw new Error(`Command failed: ${label} (exit ${result.code})\n${said}`);
  }
  return result.stdout;
}

/** Budget of one external command when a caller names none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
