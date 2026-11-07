import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { delegateToolCall, type Exec } from "./omp_delegate.js";

/** Where a person reads whether the loop is failing; the learning run writes its own line to the same file. */
export function nightlyLog(home: string = homedir()): string {
  return join(home, ".local", "share", "capability-replicas", "nightly.log");
}

/** How long a worker may run, and so how long one claim is waited on, unless the caller says otherwise. */
export const WORKER_BUDGET_S = 3_600;
export const ON_COMPLETE = ["merge", "pr-auto", "pr", "nil"] as const;
export type OnComplete = (typeof ON_COMPLETE)[number];

export interface Settings {
  projects: string[];
  per_project: number;
  concurrency: number;
  on_complete: OnComplete;
  timeout_s: number;
  dry_run: boolean;
}

export const DEFAULTS: Settings = {
  projects: ["AI Tooling", "capability-replicas"],
  per_project: 1,
  concurrency: 2,
  on_complete: "merge",
  timeout_s: WORKER_BUDGET_S,
  dry_run: false,
};

/** Applies the defaults and the bounds the Mastra input schema enforced; throws on a value outside them. */
export function settingsOf(input: Partial<Record<keyof Settings, unknown>>): Settings {
  const pick = <K extends keyof Settings>(key: K): Settings[K] => (input[key] ?? DEFAULTS[key]) as Settings[K];
  const projects = pick("projects");
  if (!Array.isArray(projects) || projects.some((p) => typeof p !== "string" || p === "")) {
    throw new Error("projects must be non-empty strings");
  }
  const bounded = (key: "per_project" | "concurrency"): number => {
    const value = pick(key);
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error(`${key} must be an integer from 1 to 8`);
    return value;
  };
  const per_project = bounded("per_project");
  const concurrency = bounded("concurrency");
  const on_complete = pick("on_complete");
  if (!ON_COMPLETE.includes(on_complete)) throw new Error(`on_complete must be one of ${ON_COMPLETE.join(", ")}`);
  const timeout_s = pick("timeout_s");
  if (!Number.isInteger(timeout_s) || timeout_s < 1) throw new Error("timeout_s must be a positive integer");
  return { projects: [...projects], per_project, concurrency, on_complete, timeout_s, dry_run: pick("dry_run") === true };
}

export type ClaimStatus = "settled" | "failed" | "running" | "refused";
/** What `start_atask_task` answers for one claim. */
export interface ClaimAnswer {
  task_id: string;
  status: ClaimStatus;
  branch?: string;
  workspace?: string;
  job_id?: string;
  verdict?: string;
  summary?: string;
  completion?: { on_complete: OnComplete; outcome: "merged" | "pull_request" | "left" | "failed"; url?: string; error?: string };
  error?: string;
}
export interface ClaimResult {
  project: string;
  answer: ClaimAnswer;
}
export interface StartInput {
  project: string;
  onComplete: OnComplete;
  add_dirs: string[];
  timeout_s: number;
}
/** The one call starting an objective: the native `start_atask_task` tool in a live run, a fake in a test. */
export interface DrainPort {
  start(input: StartInput, signal?: AbortSignal): Promise<ClaimAnswer>;
}

const STATUSES: readonly string[] = ["settled", "failed", "running", "refused"];
const OUTCOMES: readonly string[] = ["merged", "pull_request", "left", "failed"];

/** Validates a `start_atask_task` answer by hand; throws naming the field that is wrong. */
export function claimAnswerOf(value: Record<string, unknown>): ClaimAnswer {
  if (typeof value.task_id !== "string") throw new Error("start_atask_task answer has no task_id string");
  if (typeof value.status !== "string" || !STATUSES.includes(value.status)) throw new Error(`start_atask_task answer has status ${JSON.stringify(value.status)}`);
  for (const key of ["branch", "workspace", "job_id", "verdict", "summary", "error"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`start_atask_task answer ${key} is not a string`);
  }
  const completion = value.completion;
  if (completion !== undefined) {
    const c = completion as Record<string, unknown> | null;
    if (c === null || typeof c !== "object" || !OUTCOMES.includes(c.outcome as string) || !ON_COMPLETE.includes(c.on_complete as OnComplete)) {
      throw new Error("start_atask_task answer has a malformed completion");
    }
  }
  return value as unknown as ClaimAnswer;
}

/** The live port: a full omp session calls the native `start_atask_task` tool and its JSON answer is validated. */
export function liveDrainPort(exec: Exec): DrainPort {
  return {
    start: (input, signal) =>
      delegateToolCall(exec, {
        tool: "start_atask_task",
        args: input,
        validate: claimAnswerOf,
        // The tool waits `timeout_s` for the claim; the session needs room to start and print.
        timeoutMs: (input.timeout_s + 300) * 1000,
        signal,
      }),
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function refused(project: string, error: unknown): ClaimResult {
  return { project, answer: { task_id: "", status: "refused", error: messageOf(error) } };
}

/** The claims one tick makes: every project's first claim before any project's second, so an empty board cannot spend another's share. */
export function claimsOf(request: Pick<Settings, "projects" | "per_project">): string[] {
  return Array.from({ length: Math.max(request.per_project, 0) }, () => [...request.projects]).flat();
}

/** Runs every claim, `concurrency` at a time; one result per claim in claim order. A claim that throws is that lane's answer. */
export async function drainQueue(request: Settings, port: DrainPort, signal?: AbortSignal): Promise<ClaimResult[]> {
  const queue = claimsOf(request);
  const results: (ClaimResult | undefined)[] = Array.from({ length: queue.length });
  let next = 0;
  const lanes = Array.from({ length: Math.min(Math.max(request.concurrency, 1), queue.length) }, async () => {
    for (;;) {
      const index = next++;
      const project = queue[index];
      if (project === undefined) return;
      try {
        signal?.throwIfAborted();
        results[index] = {
          project,
          answer: await port.start({ project, onComplete: request.on_complete, add_dirs: [], timeout_s: request.timeout_s }, signal),
        };
      } catch (error) {
        results[index] = refused(project, error);
      }
    }
  });
  await Promise.all(lanes);
  return results.filter((result): result is ClaimResult => result !== undefined);
}

export function drainedSummary(results: readonly ClaimResult[]): string {
  const count = (status: string) => results.filter((result) => result.answer.status === status).length;
  return `${count("settled")} settled, ${count("running")} running, ${count("failed")} failed, ${count("refused")} refused`;
}

/** One readable line per claim, under the tick's own line. */
export function heartbeatText(at: string, results: readonly ClaimResult[]): string {
  const head = `${at} self-improvement tick: ${results.length} claim(s), ${drainedSummary(results)}`;
  const lines = results.map(({ project, answer }) => {
    const what = answer.completion === undefined ? "" : ` ${answer.completion.outcome}`;
    const name = answer.task_id === "" ? "(no objective)" : answer.task_id;
    const why = answer.error === undefined ? "" : `: ${answer.error}`;
    return `  ${project}: ${name} ${answer.status}${what}${why}`;
  });
  return `${[head, ...lines].join("\n")}\n`;
}

export type AppendLine = (path: string, text: string) => Promise<void>;
export const appendToFile: AppendLine = async (path, text) => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text);
};

export interface TickOutput {
  status: "drained" | "planned" | "idle";
  /** dry_run only: the projects a real tick would claim from, in claim order. */
  planned: string[];
  claims: ClaimResult[];
  heartbeat: string;
}

export interface TickDeps {
  port: DrainPort;
  append: AppendLine;
  now: () => Date;
  logPath: string;
  signal?: AbortSignal;
}

/** One tick: claim and work (unless `dry_run`), then append one line per claim to the nightly log. */
export async function selfImprovementTick(settings: Settings, deps: TickDeps): Promise<TickOutput> {
  const planned = claimsOf(settings);
  const results = settings.dry_run || planned.length === 0 ? [] : await drainQueue(settings, deps.port, deps.signal);
  const heartbeat = settings.dry_run
    ? `${deps.now().toISOString()} self-improvement dry run: would claim from ${planned.join(", ") || "no project"}\n`
    : heartbeatText(deps.now().toISOString(), results);
  if (!settings.dry_run && results.length > 0) await deps.append(deps.logPath, heartbeat);
  return {
    status: results.length === 0 ? (settings.dry_run ? "planned" : "idle") : "drained",
    planned: settings.dry_run ? planned : [],
    claims: results,
    heartbeat,
  };
}
