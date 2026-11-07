import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runBenchmark } from "./benchmark.js";
import type { BenchmarkAbOutput } from "./spec.js";

const HEARTBEAT_MS = 15_000;

export const DESCRIPTION = [
  "Time two shell commands against each other with interleaved runs and report per-arm medians; use it for before/after or candidate-vs-known-good timing evidence. It is not a profiler: use `run_command` to run one command.",
  '`floor` is the known-good control (never the broken baseline); `candidate` is the arm under test: `{"floor":{"command":"node old.js"},"candidate":{"command":"node new.js"},"runs":5,"warmup":1,"cwd":"/abs/dir","env":{"CACHE":"warm"},"timeout_seconds":60,"id":"built-vs-floor","spec_path":"bench.json"}`.',
  "Defaults: `runs` 5, `warmup` 1 (untimed), `timeout_seconds` 60 per run, `cwd` omp's directory; relative paths resolve against it.",
  'Replay a stored spec with `{"spec_from":"bench.json"}` alone (beside `spec_path` only); any inline field beside `spec_from` is refused.',
  "After warmup the arms alternate floor, candidate for `runs` rounds. Each run is `/bin/bash -lc <command>` in its own process group (`/bin/sh -c` if bash is missing); durations include shell startup in both arms; the deadline or a cancel kills the group.",
  "A run that cannot start, exits non-zero, is signalled or times out stops the benchmark: the tool fails naming arm, phase and round, and no medians are reported. A failing floor means it is not known-good.",
  "`spec_path` writes the resolved spec as JSON: it creates a file or replaces an existing stored spec, and refuses any other existing file.",
  'Returns `{status:"ok",spec,schedule,arms:{floor,candidate:{command,durations_ms}},medians:{floor_ms,candidate_ms,delta_ms,ratio},excess}`; `delta_ms` is candidate minus floor, `ratio` is null over a 0 ms floor.',
  "Executes the given commands with your permissions, `(warmup + runs) x 2` times: run only commands the user authorized.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const arm = z.object({ command: z.string().describe("Shell command this arm runs every round.") });
  return {
    name: "benchmark_ab",
    label: "Benchmark A/B",
    description: DESCRIPTION,
    parameters: z.object({
      floor: arm.nullable().optional().describe("Known-good control arm: what a good build already costs. Required unless `spec_from`."),
      candidate: arm.nullable().optional().describe("Arm under test; its excess over the floor is its cost. Required unless `spec_from`."),
      runs: z.number().int().nullable().optional().describe("Timed interleaved rounds per arm, >= 1. Default 5."),
      warmup: z.number().int().nullable().optional().describe("Untimed warmup rounds per arm, >= 0. Default 1."),
      cwd: z.string().nullable().optional().describe("Directory both arms run in. Default omp's directory; stored resolved to absolute."),
      env: z.record(z.string(), z.string()).nullable().optional().describe("Environment entries set on top of the inherited environment, both arms."),
      timeout_seconds: z.number().int().nullable().optional().describe("Per-run deadline in seconds, >= 1. Default 60."),
      id: z.string().nullable().optional().describe("Name recorded in the spec so results compare across sessions."),
      spec_path: z.string().nullable().optional().describe("Write the resolved spec as JSON here before running. Replaces only an existing stored spec."),
      spec_from: z.string().nullable().optional().describe("Replay the stored spec at this path; refused beside any inline spec field."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `benchmark_ab is timing (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { status: "running" },
        });
      }, HEARTBEAT_MS);
      let output: BenchmarkAbOutput;
      try {
        output = await runBenchmark(params, { baseDirectory: pi.cwd, ...(signal === undefined ? {} : { signal }) });
      } finally {
        clearInterval(beat);
      }
      if (output.status !== "ok") {
        const spec = output.spec === undefined ? "" : `\nspec: ${JSON.stringify(output.spec)}`;
        throw new Error(`benchmark_ab ${output.status}: ${output.reason}${spec}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
