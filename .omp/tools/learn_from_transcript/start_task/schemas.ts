import { homedir } from "node:os";

/** How long a spawned worker may run when the caller does not set `worker_timeout_s`. */
export const WORKER_BUDGET_S = 3_600;
/** How long one call waits before answering `running` when the caller does not set `timeout_s`. */
export const DEFAULT_TIMEOUT_S = 1_800;

export type OnComplete = "merge" | "pr-auto" | "pr" | "nil";
export const ON_COMPLETE_VALUES = ["merge", "pr-auto", "pr", "nil"] as const;

/** The normalized input: every default applied. */
export interface StartAtaskTaskInput {
  /** The atask objective id. Absent: `atask claim` assigns the oldest eligible task. */
  readonly id?: string;
  /** Scopes an assignment to one project. Ignored when id is set. */
  readonly project?: string;
  readonly onComplete: OnComplete;
  readonly add_dirs: readonly string[];
  readonly prompt?: string;
  readonly timeout_s: number;
  readonly worker_timeout_s?: number;
}

export interface StartAtaskTaskCompletion {
  on_complete: OnComplete;
  outcome: "merged" | "pull_request" | "left" | "failed";
  url?: string;
  error?: string;
  /** The rebase `wt merge` stopped on and the landing aborted: the target commit and the conflicting files. */
  conflict?: { onto: string; files: string[] };
}

export interface StartAtaskTaskOutput {
  task_id: string;
  status: "settled" | "failed" | "running" | "refused";
  branch?: string;
  workspace?: string;
  job_id?: string;
  /** atask's own verification verdict, when the task reached complete. */
  verdict?: string;
  summary?: string;
  /** The landing that was applied, present once the task settled. */
  completion?: StartAtaskTaskCompletion;
  error?: string;
}

/** What the model may pass: every field nullable-optional, as `pi.zod` has no `.nullish()`. */
export interface RawStartAtaskTaskParams {
  readonly id?: string | null;
  readonly project?: string | null;
  readonly onComplete?: string | null;
  readonly add_dirs?: readonly string[] | null;
  readonly prompt?: string | null;
  readonly timeout_s?: number | null;
  readonly worker_timeout_s?: number | null;
}

/** An atask id is one argv word and never a flag. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const positiveInt = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
};

/** `~` and `~/x` are expanded here: the worker's shell sees these words single-quoted, so it never would. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/** Applies the defaults and refuses values the lifecycle cannot act on; throws with the reason. */
export function normalizeInput(raw: RawStartAtaskTaskParams): StartAtaskTaskInput {
  const id = raw.id ?? undefined;
  if (id !== undefined && !TASK_ID.test(id)) {
    throw new Error(`id ${JSON.stringify(id)} is not an atask id (letters, digits, '.', '_', '-'; no leading '-')`);
  }
  const onComplete = raw.onComplete ?? "merge";
  if (!(ON_COMPLETE_VALUES as readonly string[]).includes(onComplete)) {
    throw new Error(`onComplete must be one of ${ON_COMPLETE_VALUES.join(", ")}, got ${JSON.stringify(onComplete)}`);
  }
  const project = raw.project ?? undefined;
  if (project !== undefined && project === "") throw new Error("project must not be empty");
  return {
    ...(id === undefined ? {} : { id }),
    ...(project === undefined ? {} : { project }),
    onComplete: onComplete as OnComplete,
    add_dirs: (raw.add_dirs ?? []).map(expandHome),
    ...(raw.prompt == null ? {} : { prompt: raw.prompt }),
    timeout_s: positiveInt("timeout_s", raw.timeout_s ?? DEFAULT_TIMEOUT_S),
    ...(raw.worker_timeout_s == null ? {} : { worker_timeout_s: positiveInt("worker_timeout_s", raw.worker_timeout_s) }),
  };
}
