import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GroupRunResult } from "./loop.js";
import type { GroupRunRequest } from "./types.js";
import { pidAlive } from "./worker.js";

/**
 * The state of one background group run, in a private directory under the state root:
 *
 * - `request.json`: what the runner was started with,
 * - `status.json`: the run's record, rewritten atomically by the runner (heartbeat every few seconds,
 *   and the final answer exactly once),
 * - `runner.log`: the runner's progress lines and anything it printed,
 * - `report.txt`: the final report (subject, then one line per member), written with the final record.
 *
 * A poll reads the record and decides whether the runner is still there: a record that says `running`
 * while its process is gone or its heartbeat stopped is `lost`.
 */

/** How often the runner rewrites its heartbeat. */
export const HEARTBEAT_MS = 10_000;

/** A running record whose heartbeat is older than this, or whose process is gone, is lost. */
export const LOST_AFTER_MS = 2 * 60_000;

/** How long a record may stay `starting` before the runner is considered never to have come up. */
export const START_GRACE_MS = 30_000;

export type RunState = "starting" | "running" | "settled" | "stalled" | "failed" | "lost";

export interface RunRecord {
  readonly run_id: string;
  readonly group: string;
  readonly state: RunState;
  /** The runner's process id. */
  readonly pid?: number;
  readonly started_at: number;
  readonly heartbeat_at: number;
  readonly finished_at?: number;
  /** The loop's answer, once it ended. */
  readonly result?: GroupRunResult;
  readonly subject?: string;
  readonly report?: string;
}

const TERMINAL: readonly RunState[] = ["settled", "stalled", "failed", "lost"];

export const isTerminal = (state: RunState): boolean => TERMINAL.includes(state);

export const runsRoot = (stateRoot: string): string => join(stateRoot, "runs");
export const runDirOf = (stateRoot: string, runId: string): string => join(runsRoot(stateRoot), runId);

export function newRunId(): string {
  return `gr-${randomBytes(6).toString("hex")}`;
}

/** Writes a file so a reader sees either the old content or the new, never half. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export async function createRunDir(stateRoot: string, request: GroupRunRequest): Promise<string> {
  const dir = runDirOf(stateRoot, request.run_id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "request.json"), JSON.stringify(request, null, 2), { encoding: "utf8", mode: 0o600 });
  return dir;
}

export async function writeRecord(dir: string, record: RunRecord): Promise<void> {
  await writeAtomic(join(dir, "status.json"), JSON.stringify(record, null, 2));
}

/** Synchronous variant for a signal handler or a last-gasp write. */
export function writeRecordSync(dir: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function readRecord(dir: string): Promise<RunRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Partial<RunRecord>;
    if (typeof parsed.run_id !== "string" || typeof parsed.group !== "string" || typeof parsed.state !== "string") {
      return undefined;
    }
    return parsed as RunRecord;
  } catch {
    return undefined;
  }
}

export async function readRequest(dir: string): Promise<GroupRunRequest> {
  return JSON.parse(await readFile(join(dir, "request.json"), "utf8")) as GroupRunRequest;
}

/** The last `lines` lines of the runner's log. */
export async function logTail(dir: string, lines = 12): Promise<string> {
  try {
    const text = await readFile(join(dir, "runner.log"), "utf8");
    return text.trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export interface Liveness {
  readonly now: () => number;
  readonly alive: (pid: number) => boolean;
}

export const liveLiveness: Liveness = { now: () => Date.now(), alive: pidAlive };

/**
 * The record as a reader should see it: a run that says `starting` or `running` but whose runner is
 * gone (or whose heartbeat stopped) is `lost`. Lost is a derived answer; the file is not rewritten.
 */
export function observe(record: RunRecord, liveness: Liveness = liveLiveness): RunRecord {
  if (isTerminal(record.state)) return record;
  const now = liveness.now();
  const gone = record.pid === undefined ? record.state === "running" : !liveness.alive(record.pid);
  const silent = record.state === "running"
    ? now - record.heartbeat_at > LOST_AFTER_MS
    : now - record.started_at > START_GRACE_MS;
  return gone || silent ? { ...record, state: "lost" } : record;
}

/** The run of `group` whose runner is still there, if any: starting a second one would split the claims. */
export async function activeRunOf(
  stateRoot: string,
  group: string,
  liveness: Liveness = liveLiveness,
): Promise<RunRecord | undefined> {
  let entries: string[];
  try {
    entries = await readdir(runsRoot(stateRoot));
  } catch {
    return undefined;
  }
  let newest: RunRecord | undefined;
  for (const entry of entries) {
    const record = await readRecord(join(runsRoot(stateRoot), entry));
    if (record === undefined || record.group !== group) continue;
    const seen = observe(record, liveness);
    if (isTerminal(seen.state)) continue;
    if (newest === undefined || record.started_at > newest.started_at) newest = record;
  }
  return newest;
}

/** The poll answer as text: the state, what the heartbeat says, then the report or the log tail. */
export function describeRun(record: RunRecord, tail: string, liveness: Liveness = liveLiveness): string {
  const now = liveness.now();
  const age = Math.max(0, Math.round((now - record.heartbeat_at) / 1000));
  const lines = [`run ${record.run_id} for group ${record.group}: ${record.state}`];
  if (record.state === "running" || record.state === "starting") {
    lines.push(`runner pid ${record.pid ?? "unknown"}, heartbeat ${age}s ago, started ${Math.round((now - record.started_at) / 1000)}s ago`);
  }
  if (record.state === "lost") {
    lines.push(
      `the runner is gone (last heartbeat ${age}s ago). Workers it started keep running and its claims lapse with their leases; `
        + `call complete_atask_group with the group again to continue: it adopts live workers and re-claims the rest`,
    );
  }
  if (record.subject !== undefined) lines.push(record.subject);
  if (record.report !== undefined && record.report !== "") lines.push(record.report);
  if (!isTerminal(record.state) || record.state === "lost") {
    if (tail !== "") lines.push("Recent log:", tail);
  }
  return lines.join("\n");
}
