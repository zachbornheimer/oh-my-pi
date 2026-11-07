import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchmarkEnvironment, runBenchmark } from "./benchmark.js";
import factory, { DESCRIPTION } from "./index.js";
import { median, medianComparison } from "./medians.js";
import { type BenchRunner, fileSpecStore, shellRunner, type SpecStore, type TimedRunOutcome, type TimedRunRequest } from "./ports.js";
import { inputRefusal, normalizeSpec } from "./spec.js";

interface Script {
  /** The duration each runner.run advances the clock by, in call order. */
  readonly durations?: readonly number[];
  readonly exits?: readonly (number | null)[];
  readonly timeouts?: readonly boolean[];
  /** Per call: the spawn error the runner reports instead of running. */
  readonly couldNotStart?: readonly string[];
  readonly outputs?: readonly string[];
}

/** A deterministic machine: the clock only moves when a run lands, by the scripted duration. */
function machine(script: Script) {
  let now = 0;
  const calls: TimedRunRequest[] = [];
  const runner: BenchRunner = {
    async run(request) {
      const index = calls.length;
      calls.push(request);
      if (script.couldNotStart?.[index] !== undefined) {
        return { exitCode: null, timedOut: false, couldNotStart: true, output: script.couldNotStart[index]! };
      }
      now += script.durations?.[index] ?? 0;
      const outcome: TimedRunOutcome = {
        exitCode: script.exits?.[index] === undefined ? 0 : script.exits[index]!,
        timedOut: script.timeouts?.[index] === true,
        couldNotStart: false,
        output: script.outputs?.[index] ?? "",
      };
      return outcome;
    },
  };
  const files = new Map<string, string>();
  const store: SpecStore = {
    read: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: no stored spec at ${path}`);
      return text;
    },
    write: async (path, content) => {
      files.set(path, content);
    },
    exists: async (path) => files.has(path),
  };
  const environment: BenchmarkEnvironment = {
    runner,
    clock: () => now,
    store,
    directoryExists: async () => true,
    baseDirectory: "/base",
  };
  return { environment, calls, files };
}

describe("benchmark_ab", () => {
  it("interleaves the arms, times only the timed rounds, and compares the medians", async () => {
    const { environment, calls } = machine({ durations: [900, 900, 10, 15, 12, 17] });
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 2, warmup: 1, cwd: "/abs/cwd" },
      environment,
    );
    expect(result.status).toBe("ok");
    expect(result.schedule).toEqual(["floor", "candidate", "floor", "candidate", "floor", "candidate"]);
    expect(result.arms).toEqual({
      floor: { command: "old", durations_ms: [10, 12] },
      candidate: { command: "new", durations_ms: [15, 17] },
    });
    expect(result.medians).toEqual({ floor_ms: 11, candidate_ms: 16, delta_ms: 5, ratio: 16 / 11 });
    expect(result.excess).toBe("candidate is 5.000 ms slower than the floor median (45.5% over it)");
    expect(calls.every((call) => call.cwd === "/abs/cwd")).toBe(true);
  });

  it("defaults runs to 5, warmup to 1 and the deadline to 60 s in the spec", () => {
    const spec = normalizeSpec({ floor: { command: "a" }, candidate: { command: "b" } });
    expect(spec).toMatchObject({ runs: 5, warmup: 1, timeout_seconds: 60 });
  });

  it("treats null optionals as omitted and rejects bad values by name", () => {
    expect(normalizeSpec({ floor: { command: "a" }, candidate: { command: "b" }, runs: null, env: null, cwd: null }).runs).toBe(5);
    expect(() => normalizeSpec({ floor: { command: "a" }, candidate: { command: "b" }, runs: 0 })).toThrow(/runs must be an integer >= 1/);
    expect(() => normalizeSpec({ floor: { command: "a" }, candidate: { command: "b" }, warmup: -1 })).toThrow(/warmup/);
    expect(() => normalizeSpec({ floor: { command: "a" }, candidate: { command: "  " } })).toThrow(/candidate must be/);
    expect(() => normalizeSpec({ floor: { command: "a" }, candidate: { command: "b" }, env: { A: 1 } })).toThrow(/env must map/);
    expect(() => normalizeSpec("nope")).toThrow(/JSON object/);
  });

  it("records the resolved spec and stores it for replay", async () => {
    const { environment, files } = machine({ durations: [1, 2, 1, 2] });
    const result = await runBenchmark(
      {
        id: "built-vs-floor",
        floor: { command: "node old.js" },
        candidate: { command: "node new.js" },
        runs: 2,
        warmup: 0,
        cwd: "/abs/cwd",
        env: { CACHE: "warm" },
        spec_path: "/abs/specs/bench.json",
      },
      environment,
    );
    const stored = JSON.parse(files.get("/abs/specs/bench.json")!);
    expect(stored).toEqual({
      id: "built-vs-floor",
      floor: { command: "node old.js" },
      candidate: { command: "node new.js" },
      runs: 2,
      warmup: 0,
      cwd: "/abs/cwd",
      env: { CACHE: "warm" },
      timeout_seconds: 60,
    });
    expect(result.spec).toEqual(stored);
    expect(Object.keys(stored)).not.toContain("spec_path");
    expect(Object.keys(stored)).not.toContain("spec_from");
  });

  it("replays a stored spec exactly", async () => {
    const stored = {
      id: "built-vs-floor",
      floor: { command: "cmd-floor" },
      candidate: { command: "cmd-candidate" },
      runs: 2,
      warmup: 1,
      cwd: "/abs/cwd",
    };
    const { environment, calls, files } = machine({ durations: [9, 9, 10, 15, 10, 15] });
    files.set("/abs/specs/bench.json", `${JSON.stringify(stored)}\n`);
    const result = await runBenchmark({ spec_from: "/abs/specs/bench.json" }, environment);
    expect(result.status).toBe("ok");
    expect(result.spec).toEqual({ ...stored, timeout_seconds: 60 });
    expect(calls.map((call) => call.command)).toEqual([
      "cmd-floor",
      "cmd-candidate",
      "cmd-floor",
      "cmd-candidate",
      "cmd-floor",
      "cmd-candidate",
    ]);
  });

  it("refuses inline fields beside spec_from, and an input with neither arms nor spec_from", async () => {
    expect(inputRefusal({ spec_from: "/abs/specs/bench.json", runs: 3 })).toMatch(/spec_from replays a stored spec exactly/);
    expect(inputRefusal({ spec_from: "/abs/specs/bench.json", spec_path: "/x.json", runs: null })).toBeUndefined();
    expect(inputRefusal({ floor: { command: "a" }, candidate: { command: "b" } })).toBeUndefined();
    expect(inputRefusal({})).toMatch(/floor and candidate/);
    const { environment, calls } = machine({});
    const denied = await runBenchmark({ spec_from: "/abs/specs/bench.json", runs: 3 }, environment);
    expect(denied.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("denies a stored spec that is missing or invalid", async () => {
    const { environment, files } = machine({});
    const missing = await runBenchmark({ spec_from: "/abs/none.json" }, environment);
    expect(missing).toMatchObject({ status: "denied" });
    expect(missing.reason).toMatch(/could not read the stored spec at \/abs\/none\.json/);
    files.set("/abs/bad.json", "{not json");
    const bad = await runBenchmark({ spec_from: "/abs/bad.json" }, environment);
    expect(bad.reason).toMatch(/is not a valid benchmark spec/);
  });

  it("stops when the floor is not known-good, before timing anything", async () => {
    const { environment, calls } = machine({ durations: [5], exits: [3] });
    const result = await runBenchmark(
      { floor: { command: "make floor" }, candidate: { command: "make new" }, runs: 2, warmup: 1 },
      environment,
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/floor warmup round 1 exited 3/);
    expect(result.reason).toMatch(/known-good/);
    expect(calls).toHaveLength(1);
    expect(result.spec).toBeDefined();
    expect(result.medians).toBeUndefined();
  });

  it("stops when a candidate run passes the deadline, even though a killed run has no exit code", async () => {
    const { environment } = machine({ durations: [10, 1000], timeouts: [false, true], exits: [0, null] });
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0 },
      environment,
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/candidate round 1 timed out after 60 s/);
  });

  it("reports a run ended by a signal that is not the deadline", async () => {
    const { environment } = machine({ exits: [null] });
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0 },
      environment,
    );
    expect(result.reason).toMatch(/floor round 1 was ended by a signal/);
  });

  it("reports a command that could not start", async () => {
    const { environment } = machine({ couldNotStart: ["spawn /bin/bash ENOENT"] });
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0 },
      environment,
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/floor round 1 could not start: spawn \/bin\/bash ENOENT/);
  });

  it("refuses to run when the working directory does not exist", async () => {
    const { environment, calls } = machine({});
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, cwd: "/no/such/benchmark-dir" },
      { ...environment, directoryExists: async () => false },
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/\/no\/such\/benchmark-dir does not exist/);
    expect(calls).toHaveLength(0);
  });

  it("reports a spec_path it could not store and runs nothing", async () => {
    const { environment, calls } = machine({});
    const store: SpecStore = {
      read: async () => "",
      write: async () => {
        throw new Error("EACCES: read-only file system");
      },
      exists: async () => false,
    };
    const result = await runBenchmark(
      {
        floor: { command: "old" },
        candidate: { command: "new" },
        runs: 1,
        warmup: 0,
        spec_path: "/abs/specs/bench.json",
      },
      { ...environment, store },
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/could not store the spec at \/abs\/specs\/bench\.json: EACCES/);
    expect(calls).toHaveLength(0);
    expect(result.spec).toBeDefined();
  });

  it("refuses a spec_path that names an existing file which is not a stored spec, and replaces one that is", async () => {
    const { environment, calls, files } = machine({ durations: [1, 1, 1, 1] });
    files.set("/base/notes.md", "# my notes");
    const refused = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0, spec_path: "notes.md" },
      environment,
    );
    expect(refused.status).toBe("denied");
    expect(refused.reason).toMatch(/not a stored benchmark spec/);
    expect(files.get("/base/notes.md")).toBe("# my notes");
    expect(calls).toHaveLength(0);
    files.set("/base/bench.json", JSON.stringify({ floor: { command: "a" }, candidate: { command: "b" } }));
    const replaced = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0, spec_path: "bench.json" },
      environment,
    );
    expect(replaced.status).toBe("ok");
    expect(JSON.parse(files.get("/base/bench.json")!).floor.command).toBe("old");
  });

  it("resolves a relative spec path and default cwd against the base directory", async () => {
    const { environment, files } = machine({ durations: [1, 1] });
    const result = await runBenchmark(
      { floor: { command: "old" }, candidate: { command: "new" }, runs: 1, warmup: 0, spec_path: "specs/bench.json" },
      environment,
    );
    expect(result.status).toBe("ok");
    expect(files.has("/base/specs/bench.json")).toBe(true);
    expect(result.spec?.cwd).toBe("/base");
  });

  it("stops at the first abort instead of running on", async () => {
    const { environment } = machine({ durations: [1, 1, 1, 1] });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      runBenchmark({ floor: { command: "a" }, candidate: { command: "b" }, runs: 1, warmup: 0 }, { ...environment, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("medians", () => {
  it("takes the middle duration, or the mean of the two middle ones", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(/no durations/);
  });

  it("states the candidate-vs-floor excess in both directions, and over a 0 ms floor", () => {
    expect(medianComparison([20], [10]).excess).toBe("candidate is 10.000 ms faster than the floor median (50.0% under it)");
    expect(medianComparison([20], [25]).excess).toBe("candidate is 5.000 ms slower than the floor median (25.0% over it)");
    expect(medianComparison([20], [20]).excess).toBe("candidate matches the floor median");
    const zeroFloor = medianComparison([0], [5]);
    expect(zeroFloor.ratio).toBeNull();
    expect(zeroFloor.excess).toBe("candidate is 5.000 ms slower than the floor median");
  });
});

describe("the real shell runner and store", () => {
  it("runs real commands and reports medians", async () => {
    const result = await runBenchmark(
      { floor: { command: "printf ok" }, candidate: { command: "printf ok" }, runs: 2, warmup: 0 },
      { baseDirectory: process.cwd() },
    );
    expect(result.status).toBe("ok");
    expect(result.schedule).toEqual(["floor", "candidate", "floor", "candidate"]);
    expect(result.medians!.candidate_ms).toBeGreaterThan(0);
    expect(result.spec?.cwd).toBe(process.cwd());
  });

  it("reports a floor that is not known-good, with its output", async () => {
    const result = await runBenchmark(
      { floor: { command: "echo boom >&2; exit 3" }, candidate: { command: "printf ok" } },
      { baseDirectory: process.cwd() },
    );
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/floor warmup round 1 exited 3/);
    expect(result.reason).toMatch(/boom/);
  });

  it("reports a real timeout as a timeout and kills the whole process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-timeout-"));
    try {
      const marker = join(directory, "grandchild-survived");
      const started = Date.now();
      const outcome = await shellRunner().run({
        command: `(sleep 1; touch ${marker}) & sleep 30`,
        cwd: directory,
        env: {},
        timeoutMs: 300,
      });
      expect(outcome.timedOut).toBe(true);
      expect(outcome.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      await new Promise((done) => setTimeout(done, 2300));
      expect(await Bun.file(marker).exists()).toBe(false);
      const result = await runBenchmark(
        { floor: { command: "sleep 30" }, candidate: { command: "true" }, runs: 1, warmup: 0, timeout_seconds: 1 },
        { baseDirectory: directory, runner: { run: (request) => shellRunner().run({ ...request, timeoutMs: 300 }) } },
      );
      expect(result.reason).toMatch(/floor round 1 timed out after 1 s/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills the running command when aborted", async () => {
    const controller = new AbortController();
    const pending = shellRunner().run({ command: "sleep 30", cwd: process.cwd(), env: {}, timeoutMs: 60_000, signal: controller.signal });
    controller.abort(new Error("stop")); // lands while the runner is still probing for bash, before the spawn
    await expect(pending).rejects.toThrow(/stop/);
  });

  it("passes env on top of the inherited environment", async () => {
    const result = await runBenchmark(
      {
        floor: { command: 'test "$BENCH_MODE" = warm' },
        candidate: { command: 'test "$BENCH_MODE" = warm' },
        env: { BENCH_MODE: "warm" },
        runs: 1,
        warmup: 0,
      },
      { baseDirectory: process.cwd() },
    );
    expect(result.status).toBe("ok");
  });

  it("stores and reads a spec file through the file store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-store-"));
    try {
      const path = join(directory, "bench.json");
      const stored = await runBenchmark(
        { floor: { command: "true" }, candidate: { command: "true" }, runs: 1, warmup: 0, spec_path: path },
        { baseDirectory: directory },
      );
      expect(stored.status).toBe("ok");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stored.spec);
      const replay = await runBenchmark({ spec_from: path }, { baseDirectory: directory });
      expect(replay.status).toBe("ok");
      expect(replay.spec).toEqual(stored.spec);
      await writeFile(join(directory, "other.txt"), "keep me");
      const refused = await runBenchmark(
        { floor: { command: "true" }, candidate: { command: "true" }, spec_path: join(directory, "other.txt") },
        { baseDirectory: directory },
      );
      expect(refused.status).toBe("denied");
      expect(await readFile(join(directory, "other.txt"), "utf8")).toBe("keep me");
      expect(await fileSpecStore().exists(join(directory, "nope"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the tool", () => {
  function pi() {
    const schema = (kind: string) => {
      const chain: unknown = new Proxy({ kind }, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
      return chain;
    };
    const zod = new Proxy({}, { get: (_t, kind) => () => schema(String(kind)) });
    return { zod, exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }), cwd: process.cwd(), logger: {} } as never;
  }
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { status: string; medians: unknown } }>;
  };

  it("describes itself in 80 to 250 words, naming its sibling", () => {
    const tool = factory(pi()) as unknown as Tool;
    expect(tool.name).toBe("benchmark_ab");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("run_command");
  });

  it("returns the output as text and details, and throws when the benchmark stops", async () => {
    const tool = factory(pi()) as unknown as Tool;
    const ok = await tool.execute("t1", { floor: { command: "true" }, candidate: { command: "true" }, runs: 1, warmup: 0, spec_from: null, env: null }, undefined, undefined);
    expect(ok.details.status).toBe("ok");
    expect(JSON.parse(ok.content[0]!.text)).toEqual(ok.details);
    await expect(
      tool.execute("t2", { floor: { command: "exit 4" }, candidate: { command: "true" } }, undefined, undefined),
    ).rejects.toThrow(/benchmark_ab error: floor warmup round 1 exited 4/);
    await expect(tool.execute("t3", {}, undefined, undefined)).rejects.toThrow(/benchmark_ab denied: pass both arms/);
  });
});
