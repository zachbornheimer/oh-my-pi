import { spawn } from "node:child_process";
import { abortReason } from "./text.js";

/**
 * The atask CLI mechanics: the argv-only runner, the `--json` envelope decode, the failure that
 * raises, the claim runner that never kills a claim mid-worktree, and the task statuses that mean
 * finished work.
 */

/** One atask CLI call's 60-second bound: every command except a `claim` (it builds a worktree) and a full `verify complete`. */
const ATASK_TIMEOUT_MS = 60_000;

export interface AtaskRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not start, for example when it is not installed. */
  readonly spawnError?: string;
  /**
   * Set only when the call gave up on a process it left running (`onTimeout: "leave"`, by timeout or
   * abort): resolves with that process's own result when it exits, so whoever abandoned it can still
   * read what it printed.
   */
  readonly stillRunning?: Promise<AtaskRun>;
}

/** Where one atask call runs and how long it may take. */
export interface AtaskRunOptions {
  /** The directory the call runs in: atask resolves a claim from the task worktree it runs in. */
  readonly cwd?: string;
  /** Overrides the 60-second default; a `verify complete` runs whole check suites. */
  readonly timeoutMs?: number;
  /**
   * What the bound (or an abort) does to a process still running: `kill` (the default) stops it;
   * `leave` stops waiting and lets it finish. A call that records state before it prints its answer —
   * `atask claim` prints its session token once, at the end — must never be killed, because the state
   * it recorded is then owned by a token nobody holds.
   */
  readonly onTimeout?: "kill" | "leave";
  /** Aborts the call: a `kill` call rejects with the abort reason; a `leave` call stops waiting. */
  readonly signal?: AbortSignal;
}

/** Runs `atask` with an argv array, so nothing in a title is ever interpreted by a shell. */
export type RunAtask = (argv: readonly string[], options?: AtaskRunOptions) => Promise<AtaskRun>;

/**
 * Runs the `atask` executable, looked up on `searchPath` (default: the process PATH) at each call. `cwd` is the default
 * directory. The executable name is fixed, so no caller-supplied value can choose what runs.
 */
export const ataskRunnerIn = (cwd?: string, searchPath?: string): RunAtask => (argv, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<AtaskRun>();
  const signal = options?.signal;
  if (signal?.aborted) {
    reject(abortReason(signal));
    return promise;
  }
  const leave = options?.onTimeout === "leave";
  const exited = Promise.withResolvers<AtaskRun>();
  const child = spawn("atask", [...argv], { cwd: options?.cwd ?? cwd, env: { ...process.env, PATH: searchPath ?? process.env.PATH }, shell: false });
  let answered = false;
  const answer = (settle: () => void): void => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    settle();
  };
  const giveUp = (): void =>
    answer(() => resolve({ code: 1, stdout: "", stderr: "", stillRunning: exited.promise }));
  const onAbort = (): void => {
    if (leave) return giveUp();
    child.kill("SIGKILL");
    answer(() => reject(abortReason(signal as AbortSignal)));
  };
  const timer = setTimeout(() => {
    if (leave) giveUp();
    else child.kill("SIGKILL");
  }, options?.timeoutMs ?? ATASK_TIMEOUT_MS);
  signal?.addEventListener("abort", onAbort, { once: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const settle = (run: AtaskRun): void => {
    exited.resolve(run);
    answer(() => resolve(run));
  };
  child.on("error", (error) => settle({ code: 1, stdout: "", stderr: "", spawnError: error.message }));
  child.on("close", (code) => settle({ code: code ?? 1, stdout, stderr }));
  return promise;
};

/** Whichever `atask` PATH finds first, run from `cwd` when given. */
export const runAtask: RunAtask = ataskRunnerIn();

/** One atask failure, carrying atask's own error code (`CONFLICT`, `INVALID_INPUT`, ...) and its `details` when it sent any. */
export class AtaskError extends Error {
  constructor(
    readonly call: string,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AtaskError";
  }
}

/** The statuses that mean a task has finished its work. */
const SETTLED_TASK_STATUSES: readonly string[] = ["complete", "verified"];

export function isSettledTaskStatus(status: string): boolean {
  return SETTLED_TASK_STATUSES.includes(status);
}

interface RawEnvelope {
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
}

/** A successful atask envelope: `ok`, `result`, and every other top-level field a caller may read. */
export type AtaskOkEnvelope = { readonly ok: true; readonly result: unknown } & Record<string, unknown>;

/** Decodes one atask `--json` envelope; every atask failure throws `AtaskError`, never silently. */
export function ataskEnvelope(run: AtaskRun, what: string): AtaskOkEnvelope {
  if (run.spawnError !== undefined) {
    throw new AtaskError(what, "SPAWN", `atask CLI is not runnable: ${run.spawnError}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(run.stdout);
  } catch {
    throw new AtaskError(
      what,
      "OUTPUT",
      `atask ${what} returned non-JSON output (exit ${run.code}): ${run.stderr.trim()}`,
    );
  }
  const envelope = (typeof decoded === "object" && decoded !== null ? decoded : {}) as RawEnvelope;
  if (envelope.ok !== true) {
    const message = envelope.error?.message ?? (run.stderr.trim() || `atask ${what} failed (exit ${run.code})`);
    throw new AtaskError(what, envelope.error?.code ?? `EXIT_${run.code}`, message, envelope.error?.details);
  }
  return envelope as AtaskOkEnvelope;
}

/**
 * How long one `atask claim` is waited on. A claim builds the task worktree, a full checkout that
 * took 13 seconds on an idle machine and longer than the generic 60-second bound under load.
 */
export const CLAIM_TIMEOUT_MS = 5 * 60_000;

/** The note atask records on a claim released because its caller stopped waiting. */
const ABANDONED_CLAIM_NOTE = "released: the caller stopped waiting for this claim to finish";

/**
 * Runs one `atask claim` and waits for it to finish. `atask claim` records the attempt and its lease
 * first, builds the worktree next, and prints the session token only at the end — so a claim that is
 * killed mid-way leaves the task claimed with no worktree and no token anyone can release it with.
 * A claim still running at `timeoutMs`, or when `signal` aborts, is therefore left to finish, never
 * killed; the call throws, and the claim is released with its own token the moment it prints one.
 * A refused answer never leaves a claim behind. `run` must not be bound to `signal`: the release of
 * an abandoned claim runs after the abort.
 */
export async function runClaim(
  run: RunAtask,
  argv: readonly string[],
  timeoutMs: number = CLAIM_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<AtaskRun> {
  const claim = await run(argv, { timeoutMs, onTimeout: "leave", signal });
  const { stillRunning } = claim;
  if (stillRunning === undefined) return claim;
  void stillRunning.then((finished) => releaseAbandonedClaim(run, finished));
  if (signal?.aborted) throw abortReason(signal);
  throw new AtaskError(
    "claim",
    "TIMEOUT",
    `atask claim did not finish within ${Math.round(timeoutMs / 1000)}s; it was left running and its claim `
      + "is released as soon as it finishes, so call again after that",
  );
}

/** Releases the claim a finished `atask claim` printed a token for; a claim that failed holds nothing. */
async function releaseAbandonedClaim(run: RunAtask, finished: AtaskRun): Promise<void> {
  let token: unknown;
  try {
    token = (ataskEnvelope(finished, "claim").result as { readonly token?: unknown } | undefined)?.token;
  } catch {
    return;
  }
  if (typeof token !== "string" || token === "") return;
  try {
    ataskEnvelope(await run(["--json", "claim", "release", "--note", ABANDONED_CLAIM_NOTE, token]), "release");
  } catch {
    // Nobody is left to tell: the claim's own lease expiry returns the task if this release fails.
  }
}
