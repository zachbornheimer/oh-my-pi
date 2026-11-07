#!/usr/bin/env node
// Reaps work that is never going to finish: git-hook checks, and omp's own orphaned processes.
//
// Three scopes, matching the three LaunchAgents that run this:
//   --scope long         a check started by git (hook root, or a check under one) past --max-age-min
//   --scope orphans      a check whose parent is gone (ppid 1) and which has outlived --max-age-min
//   --scope omp-orphans  an omp worker, or a Chrome-for-Testing tree omp launched, whose owner is
//                        gone (ppid 1), with no tty and past OMP_ORPHAN_MIN_AGE_MINUTES
//
// A "check started by git" is anchored, never guessed: HOOK roots (hk run, lefthook, git push/commit,
// the sah-* hook scripts) qualify on their own, and a build/test command (mise run test, go test,
// cargo test, tofu validate) qualifies only when one of those roots is above it. A plain
// `mise run test` a person started by hand is never a candidate.
//
// Orphaned omp work is anchored the same way: the command's own text has to say omp owns it — a
// `__omp_worker_*` process, or Chrome-for-Testing under omp's own ~/.omp/puppeteer tree — and the
// process must have no owner left to report to, no terminal watching it, and the age floor behind it.
// omp's resident `omp auth-broker`/`auth-gateway` services are launchd's, and are never candidates.
//
// Runs under launchd, so it uses node builtins only: no TS, no package resolution, no shell. The
// `reap_stale_checks` omp tool imports `runScan` from here and also installs a copy of this file as
// the program the LaunchAgents run.
//
// Usage: reap-stale-checks.mjs --scope long|orphans|omp-orphans [--max-age-min N] [--apply] [--json] [--quiet]
// Exit: 0 for every completed scan (candidate or not), 1 when the process table could not be read, 2 for a usage error.

import { execFile } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCK_STALE_MS = 120_000;
const TERM_GRACE_MS = 2_000;
/** How long a `ps` snapshot may take before this pass gives up and kills nothing. */
const PS_TIMEOUT_MS = 45_000;

const DEFAULT_MAX_AGE_MIN = { long: 20, orphans: 20 };
const DEFAULT_ORPHAN_MAX_AGE_MIN = 1;

/** The age floor for the omp-orphan scope: omp work this old has had its chance to report. */
export const OMP_ORPHAN_MIN_AGE_MINUTES = 10;

/** Every scope this scanner accepts; one LaunchAgent runs each of them on its own clock. */
export const SCOPES = ["long", "orphans", "omp-orphans"];

/** Where the run log and the lock live unless a caller says otherwise. */
export function defaultLogDirectory() {
  return join(homedir(), "Library", "Logs", "omp");
}

/** The run log and the lock inside `logDir`; a directory that is not absolute, or that climbs with `..`, is refused. */
function runFiles(logDir) {
  const climbs = ("/" + logDir + "/").indexOf("/../") !== -1;
  if (!isAbsolute(logDir) || climbs) {
    throw new Error("logDir must be an absolute path without .. segments: " + logDir);
  }
  const directory = logDir.replace(/\/{2,}/g, "/");
  return { logFile: join(directory, "reap-stale-checks.jsonl"), lockFile: join(directory, "reap-stale-checks.lock") };
}

/** Hook roots: a process matching one of these is a check git started, on its own evidence. */
const HOOK_ROOTS = [
  /\bmise\s+x\s+hk\b/,
  /\bhk\s+run\s+[a-z-]+/,
  /\blefthook\b/,
  /\bgit\s+(?:push|commit)\b/,
  /\/\.generated\/bin\/sah-[a-z-]+/,
  /\bsah-(?:pre-push|pre-commit|commit-msg|contract-push|go-fix)\b/,
];

/** Work a hook root runs. Only a candidate when a hook root sits above it. */
const CHECK_WORK = [
  /\bmise\s+run\s+(?:test|ci|lint|scan|typecheck|check)\b/,
  /\bgo\s+(?:test|vet)\b/,
  /\bvitest\b/,
  /\bcargo\s+test\b/,
  /\btofu\s+(?:validate|init)\b/,
  /\bnpm\s+(?:test|run\s+test)\b/,
  /\bcpanm\b/,
];

/** Never signalled themselves. Self-only: launchd owns every process, so its subtree is not exempt. */
const NEVER = [
  /\breap[-_]stale[-_]checks\b/,
  /\breap[-_]scan\b/,
  /\bbin\/capability\b/,
  /\bcapability\s+run\b/,
  /\/launchd\b/,
  /\bWindowServer\b/,
  /\bloginwindow\b/,
];

/**
 * Never signalled, and neither is anything below them: an explicit opt-out for a gate expected to run
 * long. Deliberately visible in the process command, so an exempted push is a greppable decision
 * rather than a silent exception.
 */
const NEVER_TREE = [
  /\bREAP_EXEMPT=1\b/,
];

/** omp's own worker processes: the argv[0] token omp puts on them, which nothing else on a Mac uses. */
const OMP_WORKER = /\b__omp_worker_[a-z_]+\b/;

/** Chrome-for-Testing omp downloaded into its own tree, never the user's own Google Chrome. */
const OMP_PUPPETEER_CHROME = /\/\.omp\/puppeteer\/.*Google Chrome for Testing/;

/** omp's resident background services: launchd keeps them, and no owner's death can orphan them. */
const OMP_SERVICE = /\bomp\s+auth-(?:broker|gateway)\b/;

function usage(message) {
  console.error(message);
  console.error("usage: reap-stale-checks.mjs --scope long|orphans|omp-orphans [--max-age-min N] [--apply] [--json] [--quiet]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { scope: undefined, maxAgeMin: undefined, apply: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--scope") {
      options.scope = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--scope=")) options.scope = arg.slice("--scope=".length);
    else if (arg === "--max-age-min") {
      options.maxAgeMin = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--max-age-min=")) options.maxAgeMin = Number(arg.slice("--max-age-min=".length));
    else usage(`unknown argument: ${arg}`);
  }
  if (!SCOPES.includes(options.scope)) usage(`--scope must be one of ${SCOPES.join(", ")}`);
  if (options.maxAgeMin !== undefined && !Number.isFinite(options.maxAgeMin)) usage("--max-age-min must be a number");
  return options;
}

/**
 * `ps` etime: `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS` (and `D-HH:MM` on some ps builds). Seconds out,
 * `undefined` for anything unrecognized so an unparsable age is never treated as stale.
 */
export function parseEtime(etime) {
  const daySplit = etime.split("-");
  if (daySplit.length > 2) return undefined;
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const clock = (daySplit.length === 2 ? daySplit[1] : daySplit[0]).split(":").map(Number);
  if (!Number.isFinite(days) || clock.some((part) => !Number.isFinite(part))) return undefined;
  if (clock.length === 2) return days * 86_400 + clock[0] * 60 + clock[1];
  if (clock.length === 3) return days * 86_400 + clock[0] * 3_600 + clock[1] * 60 + clock[2];
  return undefined;
}

/** The rows of `ps -Aww -o pid=,ppid=,pgid=,tty=,etime=,rss=,command=` as `{ pid, ppid, pgid, tty, ageSeconds, rssKb, command }`. */
export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tty: match[4],
      ageSeconds: parseEtime(match[5]),
      rssKb: Number(match[6]),
      command: match[7],
    });
  }
  return processes;
}

/** Every process on the machine. Async: a host under memory pressure can make `ps` itself take minutes. */
async function readProcesses(signal) {
  // Bounded, and a snapshot that never arrives ends the pass with no candidates: a reaper that cannot see the
  // process table must never guess at it.
  const { stdout } = await execFileAsync("/bin/ps", ["-Aww", "-o", "pid=,ppid=,pgid=,tty=,etime=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
    killSignal: "SIGKILL",
    signal,
  });
  return parseProcessTable(stdout);
}

function matchesAny(patterns, command) {
  return patterns.some((pattern) => pattern.test(command));
}

/** Pid, its ancestors, and everything below it: never a candidate, never collateral. */
function protectedPids(processes) {
  const byPid = tableByPid(processes);
  const protectedSet = new Set([0, 1, process.pid]);
  const seen = new Set();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); pid = entryOf(pid, byPid)?.ppid ?? 1) {
    seen.add(pid);
    protectedSet.add(pid);
  }
  return protectedSet;
}

/** The process table as a lookup by pid (no prototype, so only real pids are keys). */
function tableByPid(processes) {
  const table = Object.create(null);
  for (const entry of processes) table[entry.pid] = entry;
  return table;
}

/** The processes grouped under their parent pid. */
function tableByPpid(processes) {
  const table = Object.create(null);
  for (const entry of processes) (table[entry.ppid] ??= []).push(entry);
  return table;
}

/** The process table entry of `pid`, or undefined. */
function entryOf(pid, byPid) {
  return byPid[pid];
}

function ancestorsOf(entry, byPid) {
  const seen = new Set([entry.pid]);
  const above = [];
  let parent = entryOf(entry.ppid, byPid);
  while (parent !== undefined && !seen.has(parent.pid)) {
    seen.add(parent.pid);
    above.push(parent);
    if (parent.ppid === 1) break;
    parent = entryOf(parent.ppid, byPid);
  }
  return above;
}

function descendantsOf(root, byPpid) {
  const found = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const parentPid = queue.pop().pid;
    for (const child of byPpid[parentPid] ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * What `ps` prints in the tty column for a process with no controlling terminal (`??` on darwin, `?`
 * on linux). A tty this scanner cannot read is treated as attached: doubt must never widen a reap.
 */
const NO_TTY = new Set(["??", "?", "-"]);

/** Whether `tty` is a known absence of a terminal, rather than a terminal or an unreadable value. */
export function hasNoControllingTty(tty) {
  return typeof tty === "string" && NO_TTY.has(tty);
}

/**
 * Whether a process is orphaned omp work, and so a candidate for the omp-orphans pass.
 *
 * Conservative by construction, on evidence only:
 *   - `ppid 1`: reparented to launchd, so the owner that would read its result is gone. A process
 *     with a live parent is a running session's whatever its command looks like — and a ppid of 1
 *     also means nothing but launchd sits above it, so no live omp session is left in its tree.
 *   - no controlling tty: a terminal means someone can still see it, and stop it.
 *   - `minAgeSeconds`: a worker that just started is still reporting.
 *   - an omp-owned command: `__omp_worker_*` argv, or Chrome-for-Testing under omp's own puppeteer
 *     tree. The resident `omp auth-broker`/`auth-gateway` services are launchd's, never an orphan.
 */
export function isOrphanedOmpWork(process, minAgeSeconds) {
  if (process.ppid !== 1) return false;
  if (!hasNoControllingTty(process.tty)) return false;
  if (process.ageSeconds === undefined || process.ageSeconds < minAgeSeconds) return false;
  if (OMP_SERVICE.test(process.command)) return false;
  return OMP_WORKER.test(process.command) || OMP_PUPPETEER_CHROME.test(process.command);
}

/**
 * The processes this run would kill, each with the reason it was chosen. Pure over the snapshot, so
 * a test can pin every rule without touching a live process.
 */
export function selectCandidates(processes, options) {
  const { scope, maxAgeSeconds } = options;
  const byPid = tableByPid(processes);
  const byPpid = tableByPpid(processes);
  const protectedSet = protectedPids(processes);
  // A mark on a wrapper (`REAP_EXEMPT=1 git push …`) covers the whole tree below it, which is what a
  // person means when they mark the push rather than each hook process.
  const exempt = new Set();
  for (const process of processes) {
    if (!matchesAny(NEVER_TREE, process.command)) continue;
    exempt.add(process.pid);
    for (const child of descendantsOf(process, byPpid)) exempt.add(child.pid);
  }
  const suppressed = (process) =>
    protectedSet.has(process.pid) || exempt.has(process.pid) || matchesAny(NEVER, process.command);

  const candidates = new Map();
  if (scope === "omp-orphans") {
    // omp's own pass: the evidence is the command and a dead owner, never a hook root.
    for (const process of processes) {
      if (suppressed(process)) continue;
      if (!isOrphanedOmpWork(process, maxAgeSeconds)) continue;
      candidates.set(process.pid, { process, reason: "orphaned omp work" });
    }
  } else {
    const hookRoots = new Set();
    for (const process of processes) {
      if (suppressed(process)) continue;
      if (matchesAny(HOOK_ROOTS, process.command)) hookRoots.add(process.pid);
    }

    const checked = (process) => {
      if (matchesAny(HOOK_ROOTS, process.command)) return "hook";
      if (!matchesAny(CHECK_WORK, process.command)) return undefined;
      for (const above of ancestorsOf(process, byPid)) {
        if (hookRoots.has(above.pid)) return `under ${above.pid}`;
      }
      return undefined;
    };

    for (const process of processes) {
      if (suppressed(process)) continue;
      const reason = checked(process);
      if (reason === undefined) continue;
      if (process.ageSeconds === undefined || process.ageSeconds < maxAgeSeconds) continue;
      if (scope === "orphans" && process.ppid !== 1) continue;
      candidates.set(process.pid, { process, reason });
    }
  }

  // Kill the whole tree below each candidate: a hook's children are the work that is actually stuck.
  // The loop body adds children to `candidates`, so it walks a snapshot.
  for (const [pid, candidate] of Array.from(candidates)) {
    for (const child of descendantsOf(candidate.process, byPpid)) {
      if (suppressed(child) || candidates.has(child.pid)) continue;
      candidates.set(child.pid, { process: child, reason: `child of ${pid}` });
    }
  }
  return [...candidates.values()];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const realDeps = {
  readProcesses,
  kill: (pid, signal) => process.kill(pid, signal),
  alive,
  sleep: (ms) => {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, ms);
    return promise;
  },
  now: () => new Date(),
};

/** SIGTERM everything, wait the grace, SIGKILL what is still alive; returns the pids that survived even that. */
export async function killAll(pids, deps = realDeps) {
  for (const pid of pids) {
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      // Already gone: the outcome the kill wanted.
    }
  }
  await deps.sleep(TERM_GRACE_MS);
  const survivors = [];
  for (const pid of pids) {
    if (!deps.alive(pid)) continue;
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      // Raced with its own exit.
    }
    if (deps.alive(pid)) survivors.push(pid);
  }
  return survivors;
}

function takeLock(logDir, lockFile) {
  mkdirSync(logDir, { recursive: true });
  try {
    closeSync(openSync(lockFile, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockFile, { force: true });
        closeSync(openSync(lockFile, "wx"));
        return true;
      }
    } catch {
      // Fall through: the lock is held.
    }
    return false;
  }
}

function appendLog(logDir, logFile, record) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // A reap that cannot log still reaped.
  }
}

/** The minutes a pass's age limit defaults to for `scope`. */
export function defaultMaxAgeMinutes(scope) {
  if (scope === "orphans") return DEFAULT_ORPHAN_MAX_AGE_MIN;
  if (scope === "omp-orphans") return OMP_ORPHAN_MIN_AGE_MINUTES;
  return DEFAULT_MAX_AGE_MIN[scope];
}

/**
 * One pass for one scope. Returns the record the pass logged:
 * `{ at, scope, max_age_min, applied, scanned, candidates, killed, survivors }`, plus `skipped` when another
 * applying pass holds the lock (nothing was scanned, nothing killed) and `error` when the process table could
 * not be read (nothing killed). A pass that only reports takes no lock and writes no log line, so the log
 * (and with it `last_run_at` in the tool's status) records only passes that acted or could not.
 *
 * `options`: `{ scope, maxAgeMin?, apply?, logDir?, signal? }`. `deps` replaces `ps`, the kill, the sleep and the clock.
 */
export async function runScan(options, deps = realDeps) {
  const scope = options.scope;
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(", ")}`);
  const apply = options.apply === true;
  const logDir = options.logDir ?? defaultLogDirectory();
  const { logFile, lockFile } = runFiles(logDir);
  const maxAgeMinutes = options.maxAgeMin ?? defaultMaxAgeMinutes(scope);
  const maxAgeSeconds = maxAgeMinutes * 60;
  const base = (extra) => ({
    at: deps.now().toISOString(),
    scope,
    max_age_min: maxAgeMinutes,
    applied: false,
    scanned: 0,
    candidates: [],
    killed: [],
    survivors: [],
    ...extra,
  });

  if (apply && !takeLock(logDir, lockFile)) {
    // Someone else owns the lock. Say so in the run log — "did the agent run?" has to be answerable
    // from the log alone — and leave their lock file alone.
    const skipped = base({ skipped: "another reap holds the lock" });
    appendLog(logDir, logFile, skipped);
    return skipped;
  }
  try {
    let processes;
    try {
      processes = await deps.readProcesses(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failed = base({ error: `ps snapshot failed: ${String(error?.message ?? error).slice(0, 200)}` });
      appendLog(logDir, logFile, failed);
      return failed;
    }
    const candidates = selectCandidates(processes, { scope, maxAgeSeconds });
    const pids = candidates.map(({ process: candidate }) => candidate.pid);
    options.signal?.throwIfAborted();
    const survivors = apply && pids.length > 0 ? await killAll(pids, deps) : [];
    const result = base({
      applied: apply,
      scanned: processes.length,
      candidates: candidates.map(({ process: candidate, reason }) => ({
        pid: candidate.pid,
        ppid: candidate.ppid,
        age_min: candidate.ageSeconds === undefined ? null : Math.round(candidate.ageSeconds / 60),
        reason,
        command: candidate.command.slice(0, 200),
      })),
      killed: apply ? pids.filter((pid) => !survivors.includes(pid)) : [],
      survivors,
    });
    if (apply) appendLog(logDir, logFile, result);
    return result;
  } finally {
    if (apply) rmSync(lockFile, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runScan(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!options.quiet) {
    if (result.skipped) process.stdout.write(`reap ${result.scope}: ${result.skipped}; skipped\n`);
    else if (result.error) process.stdout.write(`reap ${result.scope}: ${result.error}, killed nothing\n`);
    else {
      const verb = result.applied ? "killed" : "would kill";
      process.stdout.write(
        `reap ${result.scope}: ${result.candidates.length} candidate(s), ${verb} ${result.applied ? result.killed.length : result.candidates.length}`
          + ` (of ${result.scanned} processes, >${result.max_age_min}m)\n`,
      );
      for (const candidate of result.candidates) {
        process.stdout.write(`  ${candidate.pid} ${candidate.age_min}m [${candidate.reason}] ${candidate.command.slice(0, 140)}\n`);
      }
    }
  }
  if (result.error) process.exitCode = 1;
}

// Executed as a program by launchd, or imported by a test: importing must not scan or kill anything.
// Inside omp's loader `process.argv[1]` and `import.meta.url` name the binary's virtual filesystem, which does not
// exist on disk: a path that cannot be resolved is "imported", never a crash.
function runAsProgram() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (runAsProgram()) {
  await main();
}
