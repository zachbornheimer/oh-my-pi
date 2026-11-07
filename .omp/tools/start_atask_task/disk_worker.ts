import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { shQuote } from "./text.js";
import { EXIT_MARKER, type WorkerPort, type WorkerSpawnRequest, type WorkerSpawnStatus, workerScript } from "./worker.js";

/**
 * Workers whose whole state lives in a log directory, not in this process: `output.log` (the
 * command's output, ending in `__exit__<code>` once it ends), `run.sh` (the script that ran it),
 * and `pane` (herdr) or `pid` (detached process). A later call, or a later omp process, finds a run
 * it never started through `find` and reads its status from the directory.
 *
 * Two launchers share the layout. The herdr launcher splits a pane off the caller's own pane, so a
 * delegated run is visible, and the pane closes itself when the command ends. The process launcher
 * (no herdr, or no pane) starts the same script as a detached process group.
 */

/** Where worker logs live. */
export const WORKER_DIR = join(homedir(), ".local", "state", "omp-start-atask-task", "workers");

/** Where the Mastra twin keeps herdr pane runs; read-only here, so a run it started is still found and attached to. */
export const LEGACY_WORKER_DIR = join(homedir(), ".local", "state", "capability-herdr", "workers");

/** The directory prefix that carries the task id, so a run is findable by task id alone. */
const DIR_PREFIX = "atask-";
const HERDR_PREFIX = "herdr:";
const PROCESS_PREFIX = "proc:";
const TAIL_BYTES = 4000;

/** One herdr invocation: the binary and its argv, answering with stdout. */
export type HerdrCall = (binary: string, args: readonly string[]) => Promise<string>;

/** What the workers need from the machine, so tests never touch a real terminal or process. */
export interface WorkerEnvironment {
  /** The herdr binary, or undefined when herdr is not installed. */
  readonly herdr?: () => Promise<string | undefined>;
  /** The pane to split the worker off from; production is this process's own `HERDR_PANE_ID`. */
  readonly paneId?: () => string | undefined;
  /** The directory new worker logs go under. */
  readonly logDir?: () => string;
  /** Other directories `find` also reads (never writes). */
  readonly legacyDirs?: () => readonly string[];
  /** Creates the worker's log directory and returns it. */
  readonly makeDir?: (parent: string, prefix: string) => Promise<string>;
  /** One herdr call. Production runs the binary; tests script the replies. */
  readonly call?: HerdrCall;
  /** Starts the detached process for a script; returns its pid. */
  readonly spawnDetached?: (scriptPath: string, cwd: string | undefined) => Promise<number>;
  /** Whether a pid is a live process. */
  readonly pidAlive?: (pid: number) => boolean;
  /** Kills a pid's process group (else the pid). */
  readonly killGroup?: (pid: number) => void;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findHerdr(): Promise<string | undefined> {
  const fromEnv = process.env.HERDR_BIN_PATH;
  if (fromEnv !== undefined && fromEnv !== "" && (await isExecutableFile(fromEnv))) return fromEnv;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "herdr");
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * One herdr call, argv-only. Throws with herdr's own message when the call fails. The executable name is the literal
 * `herdr`; the discovered binary's directory is put first on PATH, so only a binary named `herdr` can run.
 */
const liveCall: HerdrCall = (binary, args) => {
  if (basename(binary) !== "herdr") return Promise.reject(new Error(`refusing to run "${binary}": the herdr binary must be named herdr`));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const env = { ...process.env, PATH: [dirname(binary), process.env.PATH ?? ""].join(delimiter) };
  execFile("herdr", [...args], { timeout: 30_000, env }, (error, stdout, stderr) => {
    if (error !== null) reject(new Error(`herdr ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
    else resolve(stdout);
  });
  return promise;
};

const liveSpawnDetached = async (scriptPath: string, cwd: string | undefined): Promise<number> => {
  const child = spawn("sh", [scriptPath], { cwd, detached: true, stdio: "ignore", env: process.env });
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  child.once("error", reject);
  child.once("spawn", () => resolve(child.pid ?? -1));
  const pid = await promise;
  child.unref();
  return pid;
};

const livePidAlive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const liveKillGroup = (pid: number): void => {
  if (pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a group leader any more, or already gone: try the process itself.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

/** The last `bytes` of a file as text; "" when it cannot be read. */
async function readTail(path: string, bytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let offset = 0;
    if (start > 0) {
      while (offset < bytesRead && (buffer[offset]! & 0b1100_0000) === 0b1000_0000) offset += 1;
    }
    return buffer.subarray(offset, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads the exit marker the script appends, when the command has ended. */
async function exitMarker(logPath: string): Promise<{ code: number } | undefined> {
  const match = (await readTail(logPath, 256)).match(new RegExp(`${EXIT_MARKER}(-?\\d+)\\s*$`));
  return match?.[1] === undefined ? undefined : { code: Number(match[1]) };
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The pane id herdr reports for a fresh split. */
async function splitPane(call: HerdrCall, binary: string, parentPane: string, cwd: string | undefined): Promise<string> {
  const args = ["pane", "split", parentPane, "--direction", "down", "--no-focus"];
  if (cwd !== undefined) args.push("--cwd", cwd);
  const reply = JSON.parse(await call(binary, args)) as { result?: { pane?: { pane_id?: string } } };
  const paneId = reply.result?.pane?.pane_id;
  if (paneId === undefined || paneId === "") throw new Error("herdr did not report the new pane's id");
  return paneId;
}

/** A worker port backed by log directories, plus the way to find a task's existing run. */
export interface DiskWorkerPort extends WorkerPort {
  find(taskId: string): Promise<string | undefined>;
  /** The close or kill `stop` started, so a caller can wait for it. */
  closing: Promise<unknown>;
}

/**
 * The live worker port: a herdr pane when this process has a pane and herdr is installed,
 * otherwise a detached process. Status, stop and find route by the job id's prefix, so a run
 * started either way is attachable from either.
 */
export function diskWorkerPort(environment: WorkerEnvironment = {}): DiskWorkerPort {
  const binary = environment.herdr ?? findHerdr;
  const parentPane = environment.paneId ?? (() => process.env.HERDR_PANE_ID);
  const logDir = environment.logDir ?? (() => WORKER_DIR);
  const legacyDirs = environment.legacyDirs ?? (() => [LEGACY_WORKER_DIR]);
  const makeDir = environment.makeDir ?? ((parent, prefix) => mkdtemp(join(parent, prefix)));
  const call = environment.call ?? liveCall;
  const spawnDetached = environment.spawnDetached ?? liveSpawnDetached;
  const pidAlive = environment.pidAlive ?? livePidAlive;
  const killGroup = environment.killGroup ?? liveKillGroup;

  const dirOf = (jobId: string): { dir: string; kind: "herdr" | "proc" } | undefined =>
    jobId.startsWith(HERDR_PREFIX)
      ? { dir: jobId.slice(HERDR_PREFIX.length), kind: "herdr" }
      : jobId.startsWith(PROCESS_PREFIX)
      ? { dir: jobId.slice(PROCESS_PREFIX.length), kind: "proc" }
      : undefined;

  async function paneAlive(found: string, dir: string): Promise<boolean> {
    const paneId = await readTrimmed(join(dir, "pane"));
    if (paneId === undefined) return false;
    try {
      await call(found, ["pane", "get", paneId]);
      return true;
    } catch {
      return false;
    }
  }

  async function closePane(dir: string): Promise<void> {
    const found = await binary();
    if (found === undefined) return;
    const paneId = await readTrimmed(join(dir, "pane"));
    if (paneId === undefined) return;
    await call(found, ["pane", "close", paneId]).catch(() => undefined);
  }

  const port: DiskWorkerPort = {
    async start(request: WorkerSpawnRequest) {
      const found = await binary();
      const pane = parentPane();
      const root = logDir();
      await mkdir(root, { recursive: true });
      const dir = await makeDir(root, `${DIR_PREFIX}${request.taskId ?? "run"}-`);
      const logPath = join(dir, "output.log");
      await writeFile(logPath, "", "utf8");
      const scriptPath = join(dir, "run.sh");
      if (found !== undefined && pane !== undefined && pane !== "") {
        const paneId = await splitPane(call, found, pane, request.cwd);
        try {
          await writeFile(join(dir, "pane"), paneId, "utf8");
          // The pane submits one line, and a terminal in canonical mode refuses more than 1024 bytes
          // (`pane_send_failed`). A worker command carries a whole prompt, so the script goes to a
          // file and the pane runs `sh <file>`.
          await writeFile(
            scriptPath,
            workerScript({
              command: request.command,
              timeoutSeconds: request.timeoutSeconds,
              logPath,
              output: "tee",
              after: `${shQuote(found)} pane close ${shQuote(paneId)}`,
            }),
            "utf8",
          );
          await call(found, ["pane", "run", paneId, `sh ${shQuote(scriptPath)}`]);
        } catch (error) {
          await call(found, ["pane", "close", paneId]).catch(() => undefined);
          throw error;
        }
        return { job_id: `${HERDR_PREFIX}${dir}` };
      }
      await writeFile(
        scriptPath,
        workerScript({ command: request.command, timeoutSeconds: request.timeoutSeconds, logPath, output: "file" }),
        "utf8",
      );
      const pid = await spawnDetached(scriptPath, request.cwd);
      await writeFile(join(dir, "pid"), String(pid), "utf8");
      return { job_id: `${PROCESS_PREFIX}${dir}` };
    },

    async status(jobId): Promise<WorkerSpawnStatus> {
      const job = dirOf(jobId);
      if (job === undefined) return { state: "unknown" };
      const logPath = join(job.dir, "output.log");
      const ended = await exitMarker(logPath);
      if (ended !== undefined) {
        return { state: "exited", exit_code: ended.code, output_tail: await readTail(logPath, TAIL_BYTES) };
      }
      if (job.kind === "herdr") {
        const found = await binary();
        if (found !== undefined && (await paneAlive(found, job.dir))) return { state: "running" };
      } else {
        const pid = Number(await readTrimmed(join(job.dir, "pid")));
        if (Number.isInteger(pid) && pidAlive(pid)) return { state: "running" };
      }
      return { state: "killed", output_tail: await readTail(logPath, TAIL_BYTES) };
    },

    stop(jobId) {
      const job = dirOf(jobId);
      if (job === undefined) return "unknown";
      port.closing = job.kind === "herdr"
        ? closePane(job.dir)
        : readTrimmed(join(job.dir, "pid")).then((text) => {
          if (text !== undefined) killGroup(Number(text));
        });
      return "killed";
    },

    closing: Promise.resolve() as Promise<unknown>,

    async find(taskId) {
      const prefix = `${DIR_PREFIX}${taskId}-`;
      let newest: { path: string; at: number } | undefined;
      for (const root of [logDir(), ...legacyDirs()]) {
        let entries: string[];
        try {
          entries = await readdir(root);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.startsWith(prefix)) continue;
          const path = join(root, entry);
          let at: number;
          try {
            at = (await stat(path)).mtimeMs;
          } catch {
            continue;
          }
          if (newest === undefined || at > newest.at) newest = { path, at };
        }
      }
      if (newest === undefined) return undefined;
      // The directory's own marker file says which launcher made it: a pid file is a process run.
      return (await readTrimmed(join(newest.path, "pid"))) === undefined
        ? `${HERDR_PREFIX}${newest.path}`
        : `${PROCESS_PREFIX}${newest.path}`;
    },
  };
  return port;
}
