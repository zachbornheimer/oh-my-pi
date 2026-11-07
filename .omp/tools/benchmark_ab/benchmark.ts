import { resolve } from "node:path";
import { medianComparison } from "./medians.js";
import {
  type BenchRunner,
  fileSpecStore,
  isDirectory,
  missingWorkingDirectoryReason,
  performanceClock,
  shellRunner,
  type SpecStore,
  type TimedRunOutcome,
  type TimedRunRequest,
} from "./ports.js";
import {
  BENCHMARK_ARM_NAMES,
  type BenchmarkAbInput,
  type BenchmarkAbOutput,
  type BenchmarkArmName,
  type BenchmarkSpec,
  inputRefusal,
  normalizeSpec,
  type ResolvedSpec,
  specFields,
} from "./spec.js";

/**
 * benchmark_ab times two shell commands the way timing evidence can be trusted: after warmup, the arms alternate
 * floor, candidate for `runs` rounds, so system noise lands in both arms, and the medians, not single runs, are
 * compared. The floor is the known-good control, never the broken baseline, so the report states the candidate's
 * excess over the floor. The resolved spec is recorded in every result and can be stored (`spec_path`) and replayed
 * (`spec_from`), so numbers are comparable across sessions. Timing only, not a profiler: a run's output matters only
 * in the reason a failed run stopped the benchmark.
 */

/** The machine seam a caller may replace; absent entries take the production adapters. */
export interface BenchmarkEnvironment {
  readonly runner?: BenchRunner;
  readonly clock?: () => number;
  readonly store?: SpecStore;
  /** Whether the working directory exists. Production probes the file system. */
  readonly directoryExists?: (path: string) => Promise<boolean>;
  /** Directory relative `cwd`, `spec_path` and `spec_from` resolve against; default the process directory. */
  readonly baseDirectory?: string;
  readonly signal?: AbortSignal;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withResolvedCwd(spec: BenchmarkSpec, base: string): ResolvedSpec {
  return { ...spec, cwd: resolve(base, spec.cwd ?? ".") };
}

type SpecResolution = { readonly spec: ResolvedSpec } | { readonly refused: string };

/** The spec this invocation runs: the inline fields with defaults, or the stored spec at spec_from. */
async function resolveSpec(input: BenchmarkAbInput, store: SpecStore, base: string): Promise<SpecResolution> {
  if (input.spec_from === undefined || input.spec_from === null) {
    try {
      return { spec: withResolvedCwd(normalizeSpec(specFields(input)), base) };
    } catch (error) {
      return { refused: reasonOf(error) };
    }
  }
  const path = resolve(base, input.spec_from);
  let text: string;
  try {
    text = await store.read(path);
  } catch (error) {
    return { refused: `could not read the stored spec at ${path}: ${reasonOf(error)}` };
  }
  try {
    return { spec: withResolvedCwd(normalizeSpec(JSON.parse(text)), base) };
  } catch (error) {
    return { refused: `the stored spec at ${path} is not a valid benchmark spec: ${reasonOf(error)}` };
  }
}

interface ArmTimings {
  readonly schedule: BenchmarkArmName[];
  readonly floor: number[];
  readonly candidate: number[];
}

type TimedRuns = ArmTimings | { readonly stopped: string };

/** The run's output tail, when it has one: the why, capped by the runner. */
function tail(outcome: { readonly output: string }): string {
  return outcome.output === "" ? "" : ` Output: ${outcome.output}`;
}

/** Why a run did not count, or undefined when it exited 0 in time. The deadline is checked first: a killed run has no exit code. */
function failureOf(
  outcome: TimedRunOutcome,
  arm: BenchmarkArmName,
  where: string,
  timeoutSeconds: number,
): string | undefined {
  if (outcome.couldNotStart) return `${arm} ${where} could not start: ${outcome.output}`;
  if (outcome.timedOut) {
    return `${arm} ${where} timed out after ${timeoutSeconds} s: the benchmark stopped, so no medians.${tail(outcome)}`;
  }
  const knownGood = arm === "floor" ? " The floor must pass every run: it is the known-good control." : "";
  if (outcome.exitCode === null) {
    return `${arm} ${where} was ended by ${outcome.signal ?? "a signal"}: the benchmark stopped, so no medians.${knownGood}${tail(outcome)}`;
  }
  if (outcome.exitCode !== 0) {
    return `${arm} ${where} exited ${outcome.exitCode}: the benchmark stopped, so no medians.${knownGood}${tail(outcome)}`;
  }
  return undefined;
}

/**
 * Warmup then timed rounds, interleaved (floor, candidate, floor, candidate): the first run of an arm that never
 * starts, exits non-zero, is killed or times out stops the benchmark with the reason.
 */
async function timedRuns(
  spec: ResolvedSpec,
  runner: BenchRunner,
  clock: () => number,
  signal: AbortSignal | undefined,
): Promise<TimedRuns> {
  const schedule: BenchmarkArmName[] = [];
  const durations: Record<BenchmarkArmName, number[]> = { floor: [], candidate: [] };
  const request = (arm: BenchmarkArmName): TimedRunRequest => ({
    command: spec[arm].command,
    cwd: spec.cwd,
    env: spec.env ?? {},
    timeoutMs: spec.timeout_seconds * 1000,
    ...(signal === undefined ? {} : { signal }),
  });
  const runOne = async (arm: BenchmarkArmName, phase: "warmup" | "timed", round: number): Promise<string | undefined> => {
    signal?.throwIfAborted();
    const started = clock();
    const outcome = await runner.run(request(arm));
    const durationMs = clock() - started;
    schedule.push(arm);
    const where = phase === "warmup" ? `warmup round ${round}` : `round ${round}`;
    const failure = failureOf(outcome, arm, where, spec.timeout_seconds);
    if (failure !== undefined) return failure;
    if (phase === "timed") durations[arm].push(durationMs);
    return undefined;
  };
  const runPhase = async (phase: "warmup" | "timed", rounds: number): Promise<string | undefined> => {
    for (let round = 1; round <= rounds; round++) {
      for (const arm of BENCHMARK_ARM_NAMES) {
        const stopped = await runOne(arm, phase, round);
        if (stopped !== undefined) return stopped;
      }
    }
    return undefined;
  };
  const stopped = (await runPhase("warmup", spec.warmup)) ?? (await runPhase("timed", spec.runs));
  if (stopped !== undefined) return { stopped };
  return { schedule, floor: durations.floor, candidate: durations.candidate };
}

/**
 * A spec_path may only replace a file that is itself a stored benchmark spec: pointing it at any other existing file
 * is refused, so a wrong path cannot clobber a source file.
 */
async function storeRefusal(path: string, store: SpecStore): Promise<string | undefined> {
  if (!(await store.exists(path))) return undefined;
  try {
    normalizeSpec(JSON.parse(await store.read(path)));
    return undefined;
  } catch {
    return `refused: ${path} exists and is not a stored benchmark spec; spec_path only creates a file or replaces a stored spec. Nothing was run.`;
  }
}

export async function runBenchmark(
  input: BenchmarkAbInput,
  environment: BenchmarkEnvironment = {},
): Promise<BenchmarkAbOutput> {
  const runner = environment.runner ?? shellRunner();
  const clock = environment.clock ?? performanceClock();
  const store = environment.store ?? fileSpecStore();
  const directoryExists = environment.directoryExists ?? isDirectory;
  const base = resolve(environment.baseDirectory ?? process.cwd());

  const refusal = inputRefusal(input);
  if (refusal !== undefined) return { status: "denied", reason: refusal };
  const resolution = await resolveSpec(input, store, base);
  if ("refused" in resolution) return { status: "denied", reason: resolution.refused };
  const spec = resolution.spec;

  if (input.spec_path !== undefined && input.spec_path !== null) {
    const path = resolve(base, input.spec_path);
    const blocked = await storeRefusal(path, store);
    if (blocked !== undefined) return { status: "denied", reason: blocked, spec };
    try {
      await store.write(path, `${JSON.stringify(spec, null, 2)}\n`);
    } catch (error) {
      return { status: "error", reason: `could not store the spec at ${path}: ${reasonOf(error)}`, spec };
    }
  }
  if (!(await directoryExists(spec.cwd))) {
    return { status: "error", reason: missingWorkingDirectoryReason(spec.cwd), spec };
  }
  const runs = await timedRuns(spec, runner, clock, environment.signal);
  if ("stopped" in runs) return { status: "error", reason: runs.stopped, spec };
  const comparison = medianComparison(runs.floor, runs.candidate);
  return {
    status: "ok",
    spec,
    schedule: runs.schedule,
    arms: {
      floor: { command: spec.floor.command, durations_ms: runs.floor },
      candidate: { command: spec.candidate.command, durations_ms: runs.candidate },
    },
    medians: {
      floor_ms: comparison.floorMs,
      candidate_ms: comparison.candidateMs,
      delta_ms: comparison.deltaMs,
      ratio: comparison.ratio,
    },
    excess: comparison.excess,
  };
}
