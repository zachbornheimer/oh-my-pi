import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

/** A detached run: its pid, and a promise of the code it exits with (rejects when it cannot start). */
export type Launched = { pid: number; exit: Promise<number> };

export type CommandResult = { status: number; stdout: string; stderr: string };

/** `pi.exec`, as far as this tool uses it. */
export type PiExec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * Every effect the tick has: `gh`, the clock, the registry's files, the lock, and the detached run. Tests substitute
 * this; production uses `shellUpgradeBotHost`.
 */
export type UpgradeBotHost = {
  exec(bin: string, args: string[]): Promise<CommandResult>;
  now(): Date;
  /** Resolves after `ms`; rejects with the signal's reason when the tool call is cancelled first. */
  sleep(ms: number): Promise<void>;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, body: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  home(): string;
  /**
   * Creates `path` holding `body` only when it does not exist yet, atomically: no reader ever sees it empty or
   * half-written. False when it already exists.
   */
  createExclusive(path: string, body: string): Promise<boolean>;
  isAlive(pid: number): boolean;
  /** Starts `bin args` detached from this process, its stdout and stderr appended to `logPath`. */
  launch(bin: string, args: readonly string[], logPath: string): Launched;
  /** Whether the omp tool a launched run calls is installed. */
  toolInstalled(name: string): boolean;
  /** The environment variable `name`, undefined when unset. */
  env(name: string): string | undefined;
  /** Set by the tool call: aborted when the call is cancelled. */
  signal?: AbortSignal;
};

/** The real host: `pi.exec` for `gh`, node's file system, a detached `omp` process. */
export function shellUpgradeBotHost(options: {
  exec: PiExec;
  cwd: string;
  signal?: AbortSignal;
  installed: (name: string) => boolean;
}): UpgradeBotHost {
  const { signal } = options;
  return {
    signal,
    async exec(bin, args) {
      const ran = await options.exec(bin, args, { signal, cwd: options.cwd, timeout: 120_000 });
      if (ran.killed) {
        signal?.throwIfAborted();
        throw new Error(`${bin} ${args.slice(0, 3).join(" ")} was stopped after 120 s`);
      }
      return { status: ran.code, stdout: ran.stdout, stderr: ran.stderr };
    },
    now: () => new Date(),
    sleep: (ms) => sleepFor(ms, signal),
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeText(path, body) {
      mkdirSync(dirname(path), { recursive: true });
      await writeFile(path, body, { mode: 0o600 });
    },
    rename: (from, to) => rename(from, to),
    remove: (path) => rm(path, { force: true }),
    home: homedir,
    createExclusive,
    isAlive,
    launch,
    toolInstalled: options.installed,
    env: (name) => process.env[name],
  };
}

/** Sleeps `ms`; rejects at once when `signal` aborts, and always clears its timer. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason ?? new Error("cancelled"));
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** Writes a private temp file, then hard-links it to `path`: `link` fails with EEXIST when `path` exists. */
async function createExclusive(path: string, body: string): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, body, { flag: "wx", mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error(`create ${path} failed: ${(error as Error).message}`);
  } finally {
    await rm(temp, { force: true });
  }
}

/** A pid that exists but belongs to another user (EPERM) is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The only programs a detached run may start: the omp run itself, and `node` for the launcher's own process test. */
type LaunchableProgram = "omp" | "node";

/** Starts one allowlisted program detached, with an argument array and no shell; any other name is refused. */
function startDetached(bin: string, args: readonly string[], log: number) {
  const options = {
    detached: true,
    shell: false,
    stdio: ["ignore", log, log],
    env: { ...process.env, AGENTMUX_NESTED_RUN: "1", LEARNER: "1" },
  } as const;
  const name = bin as LaunchableProgram;
  switch (name) {
    case "omp":
      return spawn("omp", [...args], options);
    case "node":
      return spawn("node", [...args], options);
    default:
      throw new Error(`${bin} did not start: it is not a program a run may launch`);
  }
}

function launch(bin: string, args: readonly string[], logPath: string): Launched {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a", 0o600);
  try {
    const child = startDetached(bin, args, log);
    const { promise: exit, resolve, reject } = Promise.withResolvers<number>();
    child.on("error", (error) => reject(new Error(`${bin} failed to start: ${error.message}`)));
    child.on("exit", (code) => resolve(code ?? 1));
    // A run that fails to start rejects `exit`; the caller races it, so a rejection with no listener must not crash.
    exit.catch(() => undefined);
    if (child.pid === undefined) throw new Error(`${bin} did not start`);
    child.unref();
    return { pid: child.pid, exit };
  } finally {
    closeSync(log);
  }
}
