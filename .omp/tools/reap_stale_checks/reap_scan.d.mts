/**
 * Declaration for `reap_scan.mjs`, the scanner launchd runs and the `reap_stale_checks` tool imports. The script
 * itself runs on node builtins only; this file only names what importing it gives you.
 */

/** One `ps` row: a process on the machine. */
export interface Process {
  pid: number;
  ppid: number;
  pgid: number;
  /** What `ps` printed in the tty column: `??` (darwin) or `?` (linux) when the process has no terminal. */
  tty: string;
  /** Seconds since the process started; `undefined` when `ps`'s etime was not recognized. */
  ageSeconds: number | undefined;
  rssKb: number;
  command: string;
}

/** A process this run would kill, with the reason it was chosen. */
export interface Candidate {
  process: Process;
  reason: string;
}

/** Which pass to select for: the two git-hook passes, or omp's own orphaned work. */
export type ScanScope = "long" | "orphans" | "omp-orphans";

/** One candidate as the run log and the tool report it. */
export interface ReportedCandidate {
  pid: number;
  ppid: number;
  age_min: number | null;
  reason: string;
  command: string;
}

/** What one pass logged and returned. */
export interface ScanRecord {
  at: string;
  scope: ScanScope;
  max_age_min: number;
  applied: boolean;
  scanned: number;
  candidates: ReportedCandidate[];
  killed: number[];
  survivors: number[];
  /** Set when another applying pass held the lock: nothing was scanned or killed. */
  skipped?: string;
  /** Set when the process table could not be read: nothing was killed. */
  error?: string;
}

/** The seams a test replaces: the process table, the kill, the grace sleep and the clock. */
export interface ScanDeps {
  readProcesses(signal?: AbortSignal): Promise<Process[]>;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface ScanOptions {
  scope: ScanScope;
  maxAgeMin?: number;
  apply?: boolean;
  /** Directory of the run log and the lock; default `~/Library/Logs/omp`. */
  logDir?: string;
  signal?: AbortSignal;
}

/** Minutes omp work must live before the omp-orphan pass will claim it. */
export const OMP_ORPHAN_MIN_AGE_MINUTES: number;

/** Every scope the scanner accepts. */
export const SCOPES: readonly ScanScope[];

export function defaultLogDirectory(): string;
export function defaultMaxAgeMinutes(scope: ScanScope): number;

/** `ps` etime (`MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`) as seconds; `undefined` for anything unrecognized. */
export function parseEtime(etime: string): number | undefined;

/** The rows of `ps -Aww -o pid=,ppid=,pgid=,tty=,etime=,rss=,command=`. */
export function parseProcessTable(output: string): Process[];

/** Whether `tty` is a known *absence* of a terminal, rather than a terminal or an unreadable value. */
export function hasNoControllingTty(tty: string | undefined): boolean;

/** Whether a process is omp work whose owner is gone, and so a candidate for the omp-orphans pass. */
export function isOrphanedOmpWork(process: Process, minAgeSeconds: number): boolean;

/** The processes a pass would kill, each with the reason; pure over the snapshot. */
export function selectCandidates(
  processes: readonly Process[],
  options: { scope: ScanScope; maxAgeSeconds: number },
): Candidate[];

/** SIGTERM, grace, SIGKILL; returns the pids still alive afterwards. */
export function killAll(pids: readonly number[], deps?: ScanDeps): Promise<number[]>;

/** One pass for one scope; see the implementation for the lock, log and failure rules. */
export function runScan(options: ScanOptions, deps?: ScanDeps): Promise<ScanRecord>;
