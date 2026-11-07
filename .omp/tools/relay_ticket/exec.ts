import { type ChildProcessByStdio, spawn, type SpawnOptionsWithStdioTuple } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { frameFilter } from "./session_frames.js";

/** The bytes kept per stream: enough for a failure's reason and a session's closing output, never a whole log. */
const KEPT_BYTES = 256 * 1024;
/** After the first TERM the child's own exit path (the driver's teardown) gets this long before KILL. */
export const TERM_GRACE_MS = 60_000;
/**
 * After KILL the runtime must report the exit within this long. A child it never reports (a lost exit event, observed
 * under bun 1.4.4) would otherwise leave the answer pending forever, past the deadline and the grace.
 */
export const KILL_SETTLE_MS = 5_000;

export interface ExecOptions {
  readonly cwd?: string;
  /** The deadline: the child's process group gets TERM, then KILL after the grace. */
  readonly timeoutMs: number;
  /** Aborts like the deadline does: the run stopped, so the child's exit path must run now. */
  readonly signal?: AbortSignal;
  /** TERM-to-KILL grace; default `TERM_GRACE_MS`. */
  readonly termGraceMs?: number;
  /** KILL-to-answer bound when no exit is ever reported; default `KILL_SETTLE_MS`. */
  readonly killSettleMs?: number;
  /**
   * The command is a session driver whose stderr is its live output: every chunk of it is passed to this process's own
   * stderr as it arrives (the relay's stream sidecar reads it there while the session runs), and the worker's transcript
   * frames (`E2B-SESSION-JSONL: ...`) are left out of the `stdout` and `stderr` this answers, which keep their tail.
   */
  readonly liveSession?: boolean;
}

export interface ExecResult {
  /** The exit code; null when a signal ended it or it never started. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the deadline or the abort signal stopped it. */
  readonly stopped: boolean;
}

/** Runs one command and answers how it ended; never throws for a non-zero exit or a command that cannot start. */
export type Exec = (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

function keepTail(current: string, chunk: Buffer | string): string {
  const next = current + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  return next.length > KEPT_BYTES ? next.slice(next.length - KEPT_BYTES) : next;
}

/** Where a live session's stderr goes as it arrives. */
export type LiveSink = (text: string) => void;
/** The default drops the live copy: inside omp the TUI owns stderr, and progress reaches the caller through `onUpdate`. */
const discardLive: LiveSink = () => undefined;

/** The live copy is best-effort: a sink that fails (a closed stderr) never fails the command it watches. */
function bestEffort(sink: LiveSink): LiveSink {
  return (text) => {
    try {
      sink(text);
    } catch {
      // The answer still carries the kept tail.
    }
  };
}

/** Starts one named executable with fixed argv semantics (no shell): the spawn call names its program as a literal. */
export type Launcher = (
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
) => ChildProcessByStdio<null, Readable, Readable>;

/** The executables the relay machine runs, each launched by a spawn that names it. */
const MACHINE_LAUNCHERS: Readonly<Record<string, Launcher>> = {
  mise: (args, options) => spawn("mise", [...args], options),
  uv: (args, options) => spawn("uv", [...args], options),
  gh: (args, options) => spawn("gh", [...args], options),
  omp: (args, options) => spawn("omp", [...args], options),
};

/**
 * An exec over a closed set of launchers: the child leads its own process group, so a stop signals the whole tree the
 * way a terminal's Ctrl-C does. TERM first, because the session driver's TERM trap is what terminates its sandbox;
 * KILL only after the grace, and an answer at most `killSettleMs` after that even when no exit is ever reported. A
 * command outside the set answers as one that cannot start.
 */
export function execThrough(launchers: Readonly<Record<string, Launcher>>, live: LiveSink = discardLive): Exec {
  return (command, args, options) => {
    const launch = Object.hasOwn(launchers, command) ? launchers[command] : undefined;
    if (launch === undefined) {
      return Promise.resolve({ code: null, stdout: "", stderr: `${command}: not an executable this machine launches\n`, stopped: false });
    }
    return runLaunched(launch, command, args, options, live);
  };
}

/** The machine's exec: `mise` and `uv` (sandbox), `gh` and `omp` (landing), the only programs this tool runs. */
export const spawnExec: Exec = execThrough(MACHINE_LAUNCHERS);

function runLaunched(launch: Launcher, command: string, args: readonly string[], options: ExecOptions, live: LiveSink): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  let stdout = "";
  let stderr = "";
  let stopped = false;
  let killTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const child = launch(args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => {
      signalGroup("SIGKILL");
      const settleMs = options.killSettleMs ?? KILL_SETTLE_MS;
      settleTimer = setTimeout(() => finish(null, `${command}: no exit was reported ${settleMs} ms after SIGKILL\n`), settleMs);
    }, options.termGraceMs ?? TERM_GRACE_MS);
  };
  const deadline = setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  /**
   * What each stream's chunks go through: a live session's stderr is forwarded as it arrives and both streams' kept
   * copies drop the worker's transcript frames; any other command's chunks are kept as they come.
   */
  const streams = options.liveSession === true
    ? {
      stdout: frameFilter(() => undefined),
      stderr: frameFilter(bestEffort(live)),
      stdoutText: new StringDecoder("utf8"),
      stderrText: new StringDecoder("utf8"),
    }
    : undefined;

  const finish = (code: number | null, extra = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    options.signal?.removeEventListener("abort", stop);
    if (streams !== undefined) {
      stdout = keepTail(stdout, streams.stdout.push(streams.stdoutText.end()) + streams.stdout.end());
      stderr = keepTail(stderr, streams.stderr.push(streams.stderrText.end()) + streams.stderr.end());
    }
    resolve({ code, stdout, stderr: stderr + extra, stopped });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = keepTail(stdout, streams === undefined ? chunk : streams.stdout.push(streams.stdoutText.write(chunk)));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = keepTail(stderr, streams === undefined ? chunk : streams.stderr.push(streams.stderrText.write(chunk)));
  });
  child.on("error", (error) => finish(null, `${command}: ${error.message}\n`));
  child.on("close", (code) => finish(code));
  return promise;
}
