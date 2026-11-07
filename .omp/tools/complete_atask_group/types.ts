/** How long a spawned worker may run when the caller does not set `worker_timeout_s`. */
export const WORKER_BUDGET_S = 3_600;

/** The runner's own budget: a group of long tasks runs for hours, and each worker has its own bound. */
export const LOOP_BUDGET_S = 24 * 60 * 60;

export type GroupLanding = "merge" | "pr" | "nil";

/** The resolved input of a group run: every default applied. */
export interface GroupInput {
  readonly group: string;
  readonly max_workers: number;
  readonly onComplete: GroupLanding;
  readonly add_dirs: readonly string[];
  readonly worker_timeout_s: number;
}

/** What the detached runner needs: the input and the id of the run it belongs to. */
export interface GroupRunRequest extends GroupInput {
  readonly run_id: string;
}

/** A subtree member atask will not claim, and the checks it still lacks. */
export interface GroupDraft {
  readonly id: string;
  readonly title: string;
  /** Which of proof and regression the draft lacks. */
  readonly missing: readonly string[];
}

/** The raw tool arguments: every field a model may omit or send as null. */
export interface RawGroupInput {
  readonly group?: string | null;
  readonly max_workers?: number | null;
  readonly onComplete?: string | null;
  readonly add_dirs?: readonly string[] | null;
  readonly worker_timeout_s?: number | null;
}

const LANDINGS: readonly string[] = ["merge", "pr", "nil"];

function positiveInt(value: number | null | undefined, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** Applies the defaults and refuses a value the schema's types cannot express (a group id of blanks, a fractional count). */
export function resolveGroupInput(raw: RawGroupInput): GroupInput {
  const group = (raw.group ?? "").trim();
  if (group === "") throw new Error("group is required: the atask group id (at-XXXXXX) to run");
  const onComplete = raw.onComplete ?? "merge";
  if (!LANDINGS.includes(onComplete)) {
    throw new Error(`onComplete must be one of ${LANDINGS.join(", ")}, got ${onComplete}`);
  }
  const add_dirs = raw.add_dirs ?? [];
  if (add_dirs.some((dir) => typeof dir !== "string" || dir === "")) {
    throw new Error("add_dirs must hold non-empty directory paths");
  }
  return {
    group,
    max_workers: positiveInt(raw.max_workers, "max_workers", 4),
    onComplete: onComplete as GroupLanding,
    add_dirs: [...add_dirs],
    worker_timeout_s: positiveInt(raw.worker_timeout_s, "worker_timeout_s", WORKER_BUDGET_S),
  };
}
