import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { isDirectory, isExecutableFile, shQuote } from "./util.js";

/**
 * The background-worker port: one detached shell job per worker whose whole state lives in its own
 * directory under the workers root, so a worker outlives the runner that started it and a later
 * runner finds it again by task id. Two launchers share that layout:
 *
 * - a detached process (the default), and
 * - a herdr pane split off this process's own pane, when herdr is installed and `HERDR_PANE_ID` is set,
 *   so a delegated run is visible.
 *
 * Files in a worker directory: `command.sh` (the worker command), `run.sh` (the wrapper that enforces the
 * time budget), `output.log`, `pid` (the wrapper's pid and process group), `exit` (written last, holds the
 * exit code), `timeout` and `stopped` (markers), `mode` and `pane`.
 */

/** One worker spawn request: the shell command, the directory it runs in, and its kill timeout. */
export interface WorkerSpawnRequest {
  readonly command: string;
  readonly cwd?: string;
  /** The task the worker runs, so a later runner can find the run. */
  readonly taskId?: string;
  readonly timeoutSeconds: number;
}

export interface WorkerSpawnStatus {
  readonly state: "running" | "exited" | "killed" | "timed_out" | "unknown";
  readonly exit_code?: number;
  readonly output_tail?: string;
}

export interface WorkerPort {
  start(request: WorkerSpawnRequest): Promise<{ job_id: string }>;
  status(jobId: string): Promise<WorkerSpawnStatus>;
  /** Stops one job; a known id reports `killed`, even when it had already stopped. */
  stop(jobId: string): "killed" | "unknown";
  /** The job id of a task's newest existing run, so a later runner attaches instead of starting a second one. */
  find?(taskId: string): Promise<string | undefined>;
}

/** Where the workers' directories live by default. */
export function defaultStateRoot(): string {
  const override = process.env.COMPLETE_ATASK_GROUP_STATE_DIR;
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".local", "state", "omp", "complete_atask_group");
}

/** The directory prefix that carries the task id, so a run is findable by task id alone. */
const DIR_PREFIX = "atask-";
const TAIL_CHARS = 4000;

/** One herdr invocation: the binary and its argv, answering with stdout. */
export type HerdrCall = (binary: string, args: readonly string[]) => Promise<string>;

/** What the pane launcher needs from herdr, so tests never touch a real terminal. */
export interface HerdrEnvironment {
  /** The herdr binary, or undefined when herdr is not installed. */
  readonly herdr?: () => Promise<string | undefined>;
  /** The pane to split the worker off from; production is this process's own `HERDR_PANE_ID`. */
  readonly paneId?: () => string | undefined;
  /** One herdr call. Production runs the binary; tests script the replies. */
  readonly call?: HerdrCall;
}

export interface DiskWorkerEnvironment extends HerdrEnvironment {
  /** The workers root; defaults to `<state>/workers`. */
  readonly root?: string;
  /** Forces the launcher: `process` never uses a pane. */
  readonly launcher?: "auto" | "process";
}

async function findExecutable(explicit: string | undefined, name: string): Promise<string | undefined> {
  if (explicit !== undefined && explicit !== "" && (await isExecutableFile(explicit))) return explicit;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** `HERDR_BIN_PATH` is honoured only when it names an executable called `herdr`: no other program is ever run here. */
const liveHerdrBinary = (): Promise<string | undefined> => {
  const explicit = process.env.HERDR_BIN_PATH;
  return findExecutable(explicit !== undefined && basename(explicit) === "herdr" ? explicit : undefined, "herdr");
};

/**
 * One herdr call, argv-only. The program is always the literal `herdr`; the resolved build is pinned by
 * putting its directory first on PATH. Throws with herdr's own message when the call fails.
 */
const liveCall: HerdrCall = (binary, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  if (basename(binary) !== "herdr") {
    reject(new Error(`refusing to run ${binary}: only an executable named herdr runs here`));
    return promise;
  }
  const env = { ...process.env, PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ""}` };
  execFile("herdr", [...args], { timeout: 30_000, env }, (error, stdout, stderr) => {
    if (error !== null) reject(new Error(`herdr ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
    else resolve(stdout);
  });
  return promise;
};

/**
 * The wrapper script. It records its pid, runs the command with its output appended to the log, enforces
 * the time budget from outside the command (a watchdog that kills the whole process group), and writes
 * the exit code last. `mirror` also follows the log on the terminal, for a pane.
 */
export function workerScript(dir: string, timeoutSeconds: number, mirror: boolean): string {
  const d = shQuote(dir);
  return [
    "#!/bin/sh",
    `dir=${d}`,
    'echo $$ > "$dir/pid"',
    'sh "$dir/command.sh" >> "$dir/output.log" 2>&1 &',
    "child=$!",
    ...(mirror ? ['tail -n +1 -f "$dir/output.log" &', "tailer=$!"] : []),
    "(",
    "  trap 'kill $sleeper 2>/dev/null; exit 0' TERM",
    `  sleep ${Math.max(1, Math.floor(timeoutSeconds))} & sleeper=$!`,
    "  wait $sleeper || exit 0",
    '  : > "$dir/timeout"',
    "  kill -s KILL -- -$$ 2>/dev/null",
    "  kill -s KILL $child 2>/dev/null",
    ") >/dev/null 2>&1 &",
    "watchdog=$!",
    "wait $child",
    "code=$?",
    "kill $watchdog 2>/dev/null",
    ...(mirror ? ["kill $tailer 2>/dev/null"] : []),
    'echo $code > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"',
    "",
  ].join("\n");
}

type Mode = "proc" | "herdr";

function jobIdFor(mode: Mode, dir: string): string {
  return `${mode}:${dir}`;
}

function parseJobId(jobId: string): { mode: Mode; dir: string } | undefined {
  for (const mode of ["proc", "herdr"] as const) {
    if (jobId.startsWith(`${mode}:`)) return { mode, dir: jobId.slice(mode.length + 1) };
  }
  return undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function tailOfFile(path: string): Promise<string> {
  return ((await readText(path)) ?? "").slice(-TAIL_CHARS);
}

/** Whether a process answers signal 0; EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGKILL the wrapper's process group so the command's children die with it; fall back to the pid. */
function killGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
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
}

async function readPid(dir: string): Promise<number | undefined> {
  const text = await readText(join(dir, "pid"));
  const pid = text === undefined ? Number.NaN : Number.parseInt(text.trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

async function paneAlive(call: HerdrCall, binary: string, dir: string): Promise<boolean> {
  const paneId = ((await readText(join(dir, "pane"))) ?? "").trim();
  if (paneId === "") return false;
  try {
    await call(binary, ["pane", "get", paneId]);
    return true;
  } catch {
    return false;
  }
}

/** The pane id herdr reports for a fresh split. */
async function splitPane(call: HerdrCall, binary: string, parent: string, cwd: string | undefined): Promise<string> {
  const args = ["pane", "split", parent, "--direction", "down", "--no-focus"];
  if (cwd !== undefined) args.push("--cwd", cwd);
  const reply = JSON.parse(await call(binary, args)) as { result?: { pane?: { pane_id?: string } } };
  const paneId = reply.result?.pane?.pane_id;
  if (paneId === undefined || paneId === "") throw new Error("herdr did not report the new pane's id");
  return paneId;
}

/** Finished worker directories older than this are deleted when a new worker starts. */
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

async function pruneFinished(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if ((await stat(dir)).mtimeMs > cutoff) continue;
      const finished = ["exit", "timeout", "stopped"].some((marker) => existsSync(join(dir, marker)));
      if (finished) await rm(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export function diskWorkerPort(environment: DiskWorkerEnvironment = {}): WorkerPort {
  const root = environment.root ?? join(defaultStateRoot(), "workers");
  const herdrBinary = environment.herdr ?? liveHerdrBinary;
  const parentPane = environment.paneId ?? (() => process.env.HERDR_PANE_ID);
  const call = environment.call ?? liveCall;

  async function startInPane(dir: string, binary: string, pane: string, cwd: string | undefined): Promise<void> {
    const paneId = await splitPane(call, binary, pane, cwd);
    await writeFile(join(dir, "pane"), paneId, "utf8");
    // One submitted line must stay under 1024 bytes in a canonical-mode terminal, so the pane runs the script file.
    await call(binary, ["pane", "run", paneId, `sh ${shQuote(join(dir, "run.sh"))}; ${shQuote(binary)} pane close ${shQuote(paneId)}`]);
  }

  return {
    async start(request) {
      const cwd = request.cwd;
      if (cwd !== undefined && !(await isDirectory(cwd))) {
        throw new Error(`the worker's working directory does not exist: ${cwd}`);
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      void pruneFinished(root);
      const dir = await mkdtemp(join(root, `${DIR_PREFIX}${request.taskId ?? "run"}-`));
      const binary = environment.launcher === "process" ? undefined : await herdrBinary();
      const pane = parentPane();
      const inPane = binary !== undefined && pane !== undefined && pane !== "";
      const mode: Mode = inPane ? "herdr" : "proc";
      await writeFile(join(dir, "command.sh"), `${request.command}\n`, "utf8");
      await writeFile(join(dir, "output.log"), "", "utf8");
      await writeFile(join(dir, "mode"), mode, "utf8");
      await writeFile(join(dir, "run.sh"), workerScript(dir, request.timeoutSeconds, inPane), "utf8");
      if (inPane) {
        await startInPane(dir, binary, pane, cwd);
        return { job_id: jobIdFor("herdr", dir) };
      }
      const child = spawn("/bin/sh", [join(dir, "run.sh")], {
        cwd,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      const started = Promise.withResolvers<void>();
      child.once("spawn", () => started.resolve());
      child.once("error", (error) => started.reject(error));
      await started.promise;
      child.unref();
      if (child.pid !== undefined) await writeFile(join(dir, "pid"), String(child.pid), "utf8");
      return { job_id: jobIdFor("proc", dir) };
    },

    async status(jobId): Promise<WorkerSpawnStatus> {
      const parsed = parseJobId(jobId);
      if (parsed === undefined || !(await isDirectory(parsed.dir))) return { state: "unknown" };
      const { dir, mode } = parsed;
      const logPath = join(dir, "output.log");
      const exitText = await readText(join(dir, "exit"));
      if (exitText !== undefined) {
        const code = Number.parseInt(exitText.trim(), 10);
        return {
          state: "exited",
          ...(Number.isNaN(code) ? {} : { exit_code: code }),
          output_tail: await tailOfFile(logPath),
        };
      }
      if (existsSync(join(dir, "timeout"))) return { state: "timed_out", output_tail: await tailOfFile(logPath) };
      if (existsSync(join(dir, "stopped"))) return { state: "killed", output_tail: await tailOfFile(logPath) };
      const pid = await readPid(dir);
      if (pid !== undefined && pidAlive(pid)) return { state: "running" };
      if (mode === "herdr") {
        const binary = await herdrBinary();
        if (binary !== undefined && (await paneAlive(call, binary, dir))) return { state: "running" };
      }
      return { state: "killed", output_tail: await tailOfFile(logPath) };
    },

    stop(jobId) {
      const parsed = parseJobId(jobId);
      if (parsed === undefined || !existsSync(parsed.dir)) return "unknown";
      const { dir, mode } = parsed;
      try {
        writeFileSync(join(dir, "stopped"), "", "utf8");
      } catch {
        // the kill below still stops it
      }
      try {
        const pid = Number.parseInt(readFileSync(join(dir, "pid"), "utf8").trim(), 10);
        if (!Number.isNaN(pid)) killGroup(pid);
      } catch {
        // no pid recorded yet, or already gone
      }
      if (mode === "herdr") void closePane(call, herdrBinary, dir);
      return "killed";
    },

    async find(taskId) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        return undefined;
      }
      const prefix = `${DIR_PREFIX}${taskId}-`;
      let newest: { dir: string; mode: Mode; at: number } | undefined;
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const dir = join(root, entry);
        try {
          const at = (await stat(dir)).mtimeMs;
          if (newest === undefined || at > newest.at) {
            const mode = ((await readText(join(dir, "mode"))) ?? "proc").trim() === "herdr" ? "herdr" : "proc";
            newest = { dir, mode, at };
          }
        } catch {
          // vanished between readdir and stat
        }
      }
      return newest === undefined ? undefined : jobIdFor(newest.mode, newest.dir);
    },
  };
}

/** Closes the pane, which kills whatever still runs in it. */
async function closePane(call: HerdrCall, binary: () => Promise<string | undefined>, dir: string): Promise<void> {
  const found = await binary();
  if (found === undefined) return;
  const paneId = ((await readText(join(dir, "pane"))) ?? "").trim();
  if (paneId === "") return;
  await call(found, ["pane", "close", paneId]).catch(() => undefined);
}
