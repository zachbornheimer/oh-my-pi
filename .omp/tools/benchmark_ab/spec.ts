/**
 * The benchmark definition and the tool's input, validated in code (the tool's `parameters` schema only gives the
 * model the shape; `execute` is also called directly by tests). `null` anywhere means "omitted".
 */

export const BENCHMARK_ARM_NAMES = ["floor", "candidate"] as const;
export type BenchmarkArmName = (typeof BENCHMARK_ARM_NAMES)[number];

export const DEFAULT_RUNS = 5;
export const DEFAULT_WARMUP = 1;
export const DEFAULT_TIMEOUT_SECONDS = 60;

export interface BenchmarkArm {
  readonly command: string;
}

/**
 * The benchmark definition: the two arms and how many rounds each gets. This exact object is what `spec_path` stores
 * and every result records, so a stored spec replays the same benchmark; the invocation controls are not part of it.
 */
export interface BenchmarkSpec {
  readonly id?: string;
  readonly floor: BenchmarkArm;
  readonly candidate: BenchmarkArm;
  readonly runs: number;
  readonly warmup: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout_seconds: number;
}

/** The spec with its cwd resolved to absolute, so cwd is a fact, not a default. */
export type ResolvedSpec = BenchmarkSpec & { readonly cwd: string };

/** The tool input: the spec fields inline (none defaulted here) plus the two invocation controls. */
export interface BenchmarkAbInput {
  id?: string | null;
  floor?: { command: string } | null;
  candidate?: { command: string } | null;
  runs?: number | null;
  warmup?: number | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  timeout_seconds?: number | null;
  spec_path?: string | null;
  spec_from?: string | null;
}

export interface Medians {
  readonly floor_ms: number;
  readonly candidate_ms: number;
  readonly delta_ms: number;
  readonly ratio: number | null;
}

export interface BenchmarkAbOutput {
  readonly status: "ok" | "error" | "denied";
  /** Why no medians came out; always set on error and denied. */
  readonly reason?: string;
  /** The resolved spec this run used; every result records it, a failed one included. */
  readonly spec?: BenchmarkSpec;
  /** The arms in execution order, warmup first, then the timed rounds. */
  readonly schedule?: BenchmarkArmName[];
  readonly arms?: {
    readonly floor: { readonly command: string; readonly durations_ms: number[] };
    readonly candidate: { readonly command: string; readonly durations_ms: number[] };
  };
  readonly medians?: Medians;
  readonly excess?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function field(spec: Record<string, unknown>, key: string): unknown {
  const value = spec[key];
  return value === null ? undefined : value;
}

function arm(value: unknown, name: string): BenchmarkArm {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error(`${name} must be {"command": "<non-empty shell command>"}`);
  }
  return { command: value.command };
}

function integer(value: unknown, name: string, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Parses a spec (a stored one, or the inline fields) and fills the defaults; unknown keys are dropped. */
export function normalizeSpec(raw: unknown): BenchmarkSpec {
  if (!isRecord(raw)) throw new Error("a benchmark spec must be a JSON object");
  const id = field(raw, "id");
  if (id !== undefined && (typeof id !== "string" || id === "")) throw new Error("id must be a non-empty string");
  const cwd = field(raw, "cwd");
  if (cwd !== undefined && (typeof cwd !== "string" || cwd === "")) throw new Error("cwd must be a non-empty string");
  const env = field(raw, "env");
  if (env !== undefined) {
    if (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string")) {
      throw new Error("env must map names to string values");
    }
  }
  return {
    ...(id === undefined ? {} : { id: id as string }),
    floor: arm(field(raw, "floor"), "floor"),
    candidate: arm(field(raw, "candidate"), "candidate"),
    runs: integer(field(raw, "runs"), "runs", DEFAULT_RUNS, 1),
    warmup: integer(field(raw, "warmup"), "warmup", DEFAULT_WARMUP, 0),
    ...(cwd === undefined ? {} : { cwd: cwd as string }),
    ...(env === undefined ? {} : { env: env as Record<string, string> }),
    timeout_seconds: integer(field(raw, "timeout_seconds"), "timeout_seconds", DEFAULT_TIMEOUT_SECONDS, 1),
  };
}

const SPEC_KEYS = ["id", "floor", "candidate", "runs", "warmup", "cwd", "env", "timeout_seconds"] as const;

/** The spec fields of the input, verbatim, nulls dropped. */
export function specFields(input: BenchmarkAbInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of SPEC_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null) fields[key] = value;
  }
  return fields;
}

/**
 * The input's own consistency: both arms inline, or `spec_from` alone beside `spec_path`. Returns the refusal, or
 * undefined when the input is coherent.
 */
export function inputRefusal(input: BenchmarkAbInput): string | undefined {
  const inline = Object.keys(specFields(input));
  if (input.spec_from === undefined || input.spec_from === null) {
    if (input.floor == null || input.candidate == null) {
      return "pass both arms, floor and candidate, or spec_from to replay a stored spec";
    }
    return undefined;
  }
  if (inline.length > 0) {
    return `spec_from replays a stored spec exactly; pass its path alone beside spec_path, not ${inline.join(", ")}`;
  }
  return undefined;
}
