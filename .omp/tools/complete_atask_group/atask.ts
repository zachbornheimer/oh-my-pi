import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { isExecutableFile } from "./util.js";

/**
 * The atask CLI mechanics a group run shares: the argv-only runner, the `--json` envelope decode,
 * the failure that raises, the build that can `claim --group`, and the task statuses that mean
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
   * Set only when the call gave up on a process it left running (`onTimeout: "leave"`): resolves with
   * that process's own result when it exits, so whoever abandoned it can still read what it printed.
   */
  readonly stillRunning?: Promise<AtaskRun>;
}

export interface AtaskRunOptions {
  /** The directory the call runs in: atask resolves a claim from the task worktree it runs in. */
  readonly cwd?: string;
  /** Overrides the 60-second default; a `verify complete` runs whole check suites. */
  readonly timeoutMs?: number;
  /**
   * What the bound does to a process still running: `kill` (the default) stops it; `leave` stops
   * waiting and lets it finish. A call that records state before it prints its answer, as
   * `atask claim` does, must never be killed: the state it recorded is then owned by a token nobody holds.
   */
  readonly onTimeout?: "kill" | "leave";
}

/** Runs `atask` with an argv array, so nothing in a title is ever interpreted by a shell. */
export type RunAtask = (argv: readonly string[], options?: AtaskRunOptions) => Promise<AtaskRun>;

/**
 * Starts the executable `atask` with an argv array. An absolute `binary` pins one build by putting its
 * directory first on the child's PATH; the program spawned is always the literal `atask`, so only an
 * executable named `atask` can ever run here.
 */
function spawnAtask(binary: string, argv: readonly string[], cwd: string | undefined): ChildProcessWithoutNullStreams {
  if (basename(binary) !== "atask") throw new Error(`refusing to run ${binary}: only an executable named atask runs here`);
  const directory = dirname(binary);
  const env = directory === "." ? process.env : { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` };
  return spawn("atask", [...argv], { cwd, env, shell: false });
}

/** Runs the atask executable at `binary`: a bare name is looked up on PATH at each call, an absolute path pins one build. */
export const ataskRunnerAt = (binary: string): RunAtask => (argv, options) => {
  const { promise, resolve } = Promise.withResolvers<AtaskRun>();
  const exited = Promise.withResolvers<AtaskRun>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnAtask(binary, argv, options?.cwd);
  } catch (error) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "", spawnError: error instanceof Error ? error.message : String(error) });
  }
  const timer = setTimeout(() => {
    if (options?.onTimeout === "leave") {
      resolve({ code: 1, stdout: "", stderr: "", stillRunning: exited.promise });
    } else {
      child.kill("SIGKILL");
    }
  }, options?.timeoutMs ?? ATASK_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const settle = (run: AtaskRun): void => {
    clearTimeout(timer);
    resolve(run);
    exited.resolve(run);
  };
  child.on("error", (error) => settle({ code: 1, stdout: "", stderr: "", spawnError: error.message }));
  child.on("close", (code) => settle({ code: code ?? 1, stdout, stderr }));
  return promise;
};

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

/** A successful atask envelope: `ok`, `result`, and every other top-level field a caller's decoder may read. */
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
  const envelope = (typeof decoded === "object" && decoded !== null ? decoded : {}) as {
    ok?: unknown;
    error?: { code?: string; message?: string; details?: unknown };
  };
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
 * first, builds the worktree next, and prints the session token only at the end, so a claim that is
 * killed mid-way leaves the task claimed with no worktree and no token anyone can release it with.
 * A claim still running at `timeoutMs` is therefore left to finish, never killed; the call answers
 * with a `TIMEOUT` `AtaskError`, and the claim is released with its own token the moment it prints one.
 */
export async function runClaim(
  run: RunAtask,
  argv: readonly string[],
  timeoutMs: number = CLAIM_TIMEOUT_MS,
): Promise<AtaskRun> {
  const claim = await run(argv, { timeoutMs, onTimeout: "leave" });
  const { stillRunning } = claim;
  if (stillRunning === undefined) return claim;
  void stillRunning.then((finished) => releaseAbandonedClaim(run, finished));
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

/**
 * Which `atask` executable serves a group run. A group run claims with `atask claim --group`, which
 * only newer atask builds have; an older build fails only on that call, with
 * `flag provided but not defined: -group`. The machine can hold several builds, and which one a bare
 * `atask` reaches depends on the PATH of whatever started the process, so the run asks each build on
 * PATH what its `claim` takes and uses the first that takes `--group`.
 */

/** One probe answers in well under a second; the bound only has to outlast a machine under heavy load. */
const PROBE_TIMEOUT_MS = 30_000;

export interface AtaskBuild {
  readonly path: string;
  readonly claimsByGroup: boolean;
}

export type GroupAtaskChoice =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing"; readonly reason: string };

/** The first build in PATH order that can claim by group, else why none can. */
export function chooseGroupAtask(builds: readonly AtaskBuild[]): GroupAtaskChoice {
  const capable = builds.find((build) => build.claimsByGroup);
  if (capable !== undefined) return { kind: "found", path: capable.path };
  if (builds.length === 0) return { kind: "missing", reason: "no atask executable is on PATH" };
  return {
    kind: "missing",
    reason: `no atask on PATH supports \`claim --group\`; found ${builds.map((build) => build.path).join(", ")}. `
      + "Put an atask that does ahead of them on PATH",
  };
}

/** Whether `atask --json help claim` lists a `group` flag. */
function helpListsGroupFlag(envelope: AtaskOkEnvelope): boolean {
  const result = envelope.result as { flags?: unknown } | null | undefined;
  return Array.isArray(result?.flags)
    && result.flags.some((flag) => typeof flag === "object" && flag !== null && (flag as { name?: unknown }).name === "group");
}

async function claimsByGroup(path: string): Promise<boolean> {
  try {
    const help = await ataskRunnerAt(path)(["--json", "help", "claim"], { timeoutMs: PROBE_TIMEOUT_MS });
    return helpListsGroupFlag(ataskEnvelope(help, "help claim"));
  } catch {
    return false; // a build that cannot even print its help cannot be trusted with a claim
  }
}

/** Every distinct executable named `atask` in the PATH directories, in PATH order. */
async function ataskExecutablesOn(pathEnv: string | undefined): Promise<string[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const directory of (pathEnv ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "atask");
    if (!(await isExecutableFile(candidate))) continue;
    const identity = await realpath(candidate).catch(() => candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    found.push(candidate);
  }
  return found;
}

async function resolveGroupAtask(pathEnv: string | undefined): Promise<GroupAtaskChoice> {
  const builds = await Promise.all(
    (await ataskExecutablesOn(pathEnv)).map(async (path) => ({ path, claimsByGroup: await claimsByGroup(path) })),
  );
  return chooseGroupAtask(builds);
}

/**
 * Runs every call on the atask build that can claim by group. The build is chosen on the first call,
 * from the PATH then, and kept for this runner's life; when none can, every call answers with a
 * `spawnError` naming what was found, which `ataskEnvelope` raises as the call's failure.
 */
export function groupCapableRunAtask(pathEnv: () => string | undefined = () => process.env.PATH): RunAtask {
  let choice: Promise<GroupAtaskChoice> | undefined;
  return async (argv, options) => {
    choice ??= resolveGroupAtask(pathEnv());
    const chosen = await choice;
    if (chosen.kind === "missing") return { code: 1, stdout: "", stderr: "", spawnError: chosen.reason };
    return ataskRunnerAt(chosen.path)(argv, options);
  };
}

/** One project as `atask projects --json` lists it. */
export interface AtaskProject {
  readonly id: string;
  readonly name: string;
  readonly root_path?: string;
}

const PROJECT_ID = /^proj-[a-z0-9]+$/;

/** atask's own name rule: case and punctuation are ignored, so `AI Tooling` and `ai-tooling` are the same name. */
const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The board to pass as `--project` for `project`: an id passes through, a name answers the one project carrying it. */
export async function resolveProject(project: string, run: RunAtask): Promise<string> {
  if (PROJECT_ID.test(project)) return project;
  try {
    const listing = await run(["--json", "projects"]);
    if (listing.spawnError !== undefined) return project;
    const envelope = JSON.parse(listing.stdout) as { ok?: boolean; result?: unknown };
    if (envelope.ok !== true || !Array.isArray(envelope.result)) return project;
    const key = nameKey(project);
    if (key === "") return project;
    const named = envelope.result.flatMap((entry: unknown) => {
      const found = entry as { id?: unknown; name?: unknown; root_path?: unknown };
      if (typeof found.id !== "string" || typeof found.name !== "string") return [];
      const root = typeof found.root_path === "string" && found.root_path !== "" ? found.root_path : undefined;
      return nameKey(found.name) === key ? [{ id: found.id, root }] : [];
    });
    if (named.length === 1) return named[0]!.id;
    const checkedOut = named.filter((entry) => entry.root !== undefined);
    return checkedOut.length === 1 ? checkedOut[0]!.id : project;
  } catch {
    // A registry that cannot be read must not turn a readable project into a lost one: atask answers the name.
    return project;
  }
}
