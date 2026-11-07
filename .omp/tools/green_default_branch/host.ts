import { spawn } from "node:child_process";
import { access, appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { STATE_DIR, STATE_DIR_ENV, WORKTREES, WORKTREES_ENV } from "./constants.js";

/** `timedOut` is set when `timeoutMs` stopped the command. */
export type CommandResult = { status: number; stdout: string; stderr: string; pid?: number; timedOut?: boolean };

/** `onPid` is told the child's pid as soon as it starts. `timeoutMs` stops it (SIGTERM, then SIGKILL). The child gets no stdin. */
export type ExecOptions = { cwd?: string; onPid?: (pid: number) => void; timeoutMs?: number };

/** Narrow effects. Tests substitute this; production uses `shellHost`. */
export type Host = {
  exec(bin: string, args: string[], opts?: ExecOptions): Promise<CommandResult>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  kill(pid: number): Promise<void>;
  expand(path: string): string;
  stateDir(): string;
  worktrees(): string;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, body: string): Promise<void>;
  appendText(path: string, line: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Makes `path` executable by its owner (a git hook). */
  makeExecutable(path: string): Promise<void>;
  /** True when `path` exists. */
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
};

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

/** The most of each stream a command keeps; the tail wins, because a failure says what went wrong last. */
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;

/**
 * The real host. `signal` stops every command it started (SIGTERM, then SIGKILL after a grace) and every sleep, and
 * makes both reject, so a cancelled run leaves no child behind.
 */
export function shellHost(signal?: AbortSignal): Host {
  return {
    exec: (bin, args, opts) => shellExec(bin, args, opts, signal),
    now: () => new Date(),
    sleep: (ms) => abortableSleep(ms, signal),
    kill: (pid) => killPid(pid),
    expand: expandHome,
    stateDir: () => expandHome(process.env[STATE_DIR_ENV] ?? STATE_DIR),
    worktrees: () => expandHome(process.env[WORKTREES_ENV] ?? WORKTREES),
    readText,
    writeText,
    appendText,
    rename,
    // A build the fixer started can still be writing while the clone is removed (ENOTEMPTY); rm retries those.
    remove: (path) => rm(path, { force: true, recursive: true, maxRetries: 5, retryDelay: 500 }),
    makeExecutable: async (path) => {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, 0o755);
    },
    exists: async (path) => {
      const { access } = await import("node:fs/promises");
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new Error("green_default_branch was cancelled"));
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Error("green_default_branch was cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw new Error(`kill ${pid} failed: ${(error as Error).message}`);
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`read ${path} failed: ${(error as Error).message}`);
  }
}

async function writeText(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

async function appendText(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line.endsWith("\n") ? line : `${line}\n`);
}

/** The only programs the real host runs: git, gh and omp, and `node` for the host's own process tests. */
type AllowedBinary = "git" | "gh" | "omp" | "node";

/** Starts one allowlisted program with an argument array and no shell; any other name is refused. */
function startAllowed(bin: string, args: string[], cwd: string | undefined) {
  const options = { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] } as const;
  const name = bin as AllowedBinary;
  switch (name) {
    case "git":
      return spawn("git", args, options);
    case "gh":
      return spawn("gh", args, options);
    case "omp":
      return spawn("omp", args, options);
    case "node":
      return spawn("node", args, options);
    default:
      throw new Error(`${bin} is not a program the host may run`);
  }
}

function shellExec(
  bin: string,
  args: string[],
  opts: ExecOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  if (signal?.aborted) {
    reject(new Error(`${bin} was cancelled before it started`));
    return promise;
  }
  let child: ReturnType<typeof startAllowed>;
  try {
    child = startAllowed(bin, args, opts?.cwd);
  } catch (error) {
    reject(error);
    return promise;
  }
  if (child.pid !== undefined) opts?.onPid?.(child.pid);
  let stdout = "";
  let stderr = "";
  let cancelled = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const stop = (): void => {
    cancelled = true;
    terminate();
  };
  const limit = opts?.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  const done = (): void => {
    clearTimeout(limit);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-MAX_CAPTURE_CHARS);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_CAPTURE_CHARS);
  });
  child.on("error", (error) => {
    done();
    reject(new Error(`${bin} failed to start: ${error.message}`));
  });
  child.on("close", (status) => {
    done();
    if (cancelled) reject(new Error(`${bin} was cancelled`));
    else resolve({ status: status ?? -1, stdout, stderr, pid: child.pid, ...(timedOut ? { timedOut } : {}) });
  });
  return promise;
}