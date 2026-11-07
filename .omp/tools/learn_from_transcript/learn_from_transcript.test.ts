// The learn chain against fakes: no model, no atask, no worker, no network. The agent step is a scripted answer per
// question, atask is a scripted CLI, the worker run is a recorder, and the machine is a temp home.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type LearnDeps, learnFromTranscript, loadPreambles } from "./chain.js";
import { execAtask } from "./exec_atask.js";
import {
  type AgentRequest,
  type AgentStep,
  type Exec,
  type ExecResult,
  AnswerMissing,
  ompAgentStep,
  parseAnswer,
} from "./omp_agent.js";
import {
  type DelegatedObjective,
  type FiledObjective,
  type StartTask,
  ataskFilingPort,
  dispatchObjectives,
  fileObjectives,
  filingHeadline,
  groupByProjectLane,
  objectivesOf,
} from "./objectives.js";
import { loadQuestionFile, parseQuestionFile, promptTextOf, schemaViolations } from "./questions.js";
import type { TurnSource } from "./reader/turn_source.js";
import type { AtaskRun, RunAtask } from "./start_task/atask_cli.js";
import { startAtaskTask } from "./start_task/lifecycle.js";
import type { StartAtaskTaskInput, StartAtaskTaskOutput } from "./start_task/schemas.js";
import { RunTurns, openThread } from "./thread.js";
import { computeTriageScore, extractOmpSessionTelemetry, triageSessions } from "./triage.js";
import { YOUNGEST_POOL, worstUnlearnedSource } from "./worst_unlearned.js";
import factory, { DESCRIPTION, resultText } from "./index.js";

const made: string[] = [];
function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `learn-from-transcript-${prefix}-`));
  made.push(path);
  return path;
}
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------------------------------------------
// The question files
// ---------------------------------------------------------------------------------------------------------------

describe("question files", () => {
  it("loads the four chain files with their fields and renders {transcript} and {forensics} in code", async () => {
    const analyze = await loadQuestionFile("analyze");
    expect(analyze.fields.map((field) => field.name)).toEqual(["Analysis"]);
    expect(promptTextOf(analyze, { transcript: "/t/s.annotated.json" })).toContain(
      "Here's a transcript to review: /t/s.annotated.json",
    );
    const rootCause = await loadQuestionFile("root_cause");
    expect(rootCause.fields.map((field) => field.name)).toEqual(["RootCauses"]);
    const triage = await loadQuestionFile("pm_triage");
    expect(promptTextOf(triage, { forensics: "/threads/f.jsonl" })).toContain("session transcript at /threads/f.jsonl");
    const review = await loadQuestionFile("pm_review");
    expect(review.fields.map((field) => field.name)).toEqual(["Objectives"]);
  });

  it("refuses a state key nothing in the file renders, and a criteria question", () => {
    const file = parseQuestionFile("t", "Q:\n  instructions: ask {x}\n  schema:\n    type: array\n");
    expect(() => promptTextOf(file, { y: 1 })).toThrow("no {y} to render");
    expect(() => parseQuestionFile("t", "Q:\n  instructions: ask\n  criteria:\n    'true': y\n    'false': n\n")).toThrow(
      "criteria (decision) question",
    );
    expect(() => parseQuestionFile("t", "Q:\n  instructions: ask\n  schema:\n    type: string\n")).toThrow("unconstrained prose");
  });

  it("validates answers against the schema: required fields, unknown keys, minItems, maxItems and URLs", async () => {
    const triage = await loadQuestionFile("pm_triage");
    const schema = triage.fields[0]!.schema;
    expect(schemaViolations([], schema, "PmTriage")).toContain("PmTriage needs at least 1 item(s)");
    expect(schemaViolations([{ title: "t", priority: 9 }], schema, "PmTriage").join(" ")).toContain("above the maximum");
    expect(schemaViolations([{ title: "t", priority: 1, invariant: "i", proof: "p", regression: "r", extra: 1 }], schema, "PmTriage").join(" "))
      .toContain("unknown property extra");
    const review = (await loadQuestionFile("pm_review")).fields[0]!.schema;
    expect(schemaViolations([{ title: "t", linear_link: "not a url" }], review, "Objectives").join(" ")).toContain("must be a URL");
    // FIXED: `maxItems` was declared but never enforced.
    expect(schemaViolations([1, 2, 3], { type: "array", maxItems: 2 }, "x")).toEqual(["x allows at most 2 item(s)"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Triage and the absent-source pick (ported from packages/ai/test/worst_unlearned.test.ts)
// ---------------------------------------------------------------------------------------------------------------

const idOf = (n: number): string => `aaaa${n.toString(16).padStart(4, "0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;

/** One omp session file under `home`: `atMs` stamps it, every turn spans `spanMinutes`. */
function seedSession(home: string, id: string, atMs: number, humanTurns: number, toolErrors: number, spanMinutes = 45): string {
  const path = join(home, ".omp", "agent", "sessions", "proj", `${atMs}_${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (let turn = 1; turn <= humanTurns; turn++) {
    const start = atMs + turn * 60_000;
    lines.push(JSON.stringify({
      type: "message",
      message: { role: "user", content: `please fix the failing check ${turn}`, timestamp: new Date(start).toISOString() },
    }));
    lines.push(JSON.stringify({
      type: "message",
      message: { role: "assistant", content: "on it", timestamp: new Date(start + spanMinutes * 60_000).toISOString() },
    }));
  }
  for (let error = 0; error < toolErrors; error++) {
    lines.push(JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        isError: true,
        toolCallId: `call-${error}`,
        content: [{ type: "text", text: "the command failed" }],
        timestamp: new Date(atMs + 90_000).toISOString(),
      },
    }));
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  utimesSync(path, new Date(atMs), new Date(atMs));
  return path;
}

describe("triage", () => {
  it("reads telemetry from an omp session and skips a learner or PM session itself", () => {
    const home = temp("telemetry");
    const path = seedSession(home, idOf(0), 1730000000000, 3, 4);
    const telemetry = extractOmpSessionTelemetry({
      conversation: `omp:${idOf(0)}`,
      source: path,
      day: "2024-10-27",
      rawJsonl: readFileSync(path, "utf8"),
    });
    expect(telemetry).toMatchObject({ human_turns: 3, tool_errors: 4, tool_calls: 0, model_switches: 0 });
    expect(telemetry!.active_wall_minutes).toBeGreaterThan(60);
    expect(telemetry!.human_excerpts).toHaveLength(3);

    for (const marker of [
      "Here's a transcript to review: /x",
      "<stage1_forensics_conversation>",
      "You are the **Stage 2 Forensic PM Agent**",
    ]) {
      const raw = `${JSON.stringify({ type: "message", message: { role: "user", content: marker } })}\n`;
      expect(extractOmpSessionTelemetry({ conversation: "omp:x", source: "/x", day: "2026-01-01", rawJsonl: raw })).toBeUndefined();
    }
  });

  it("scores the deterministic waste floors alone and ranks worst first, selecting only past the bar", () => {
    const base = {
      conversation: "c", source: "s", day: "2026-01-01", bytes: 1, human_turns: 2, tool_calls: 0, model_switches: 0,
      longest_turn_minutes: 0, total_tokens: 0, models_used: [], human_excerpts: [], error_excerpts: [],
    };
    const worst = { ...base, source: "worst", tool_errors: 25, active_wall_minutes: 90, cost_usd: 25 };
    const mild = { ...base, source: "mild", tool_errors: 1, active_wall_minutes: 5, cost_usd: 0 };
    expect(computeTriageScore(worst)).toBe(0.48);
    expect(computeTriageScore(mild)).toBeLessThan(0.05);
    const ranked = triageSessions([mild, worst]);
    expect(ranked.map((session) => session.source)).toEqual(["worst", "mild"]);
    expect(ranked.map((session) => session.triage.selected)).toEqual([true, false]);
  });
});

describe("worstUnlearnedSource on a seeded machine", () => {
  const records = (home: string) => ({ home, annotatedDir: join(home, "annotated") });

  it("picks the worst unlearned session of the youngest pool", async () => {
    const home = temp("pick");
    const worst = seedSession(home, idOf(0), 1730000000000, 3, 25);
    seedSession(home, idOf(1), 1730000100000, 2, 1, 5);
    expect(await worstUnlearnedSource(records(home))).toBe(worst);
  });

  it("skips a session the sweep's ledger already learned from and picks the next worst", async () => {
    const home = temp("ledger");
    seedSession(home, idOf(0), 1730000000000, 3, 25);
    const next = seedSession(home, idOf(1), 1730000100000, 2, 1, 5);
    const ledger = join(home, ".local", "share", "capability-replicas", "learned.jsonl");
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify({ conversation: `omp:${idOf(0)}` })}\nnot json\n`);
    expect(await worstUnlearnedSource(records(home))).toBe(next);
  });

  it("skips a session the launch log learned from and the one it runs in itself", async () => {
    const home = temp("launch");
    seedSession(home, idOf(0), 1730000000000, 3, 25);
    const next = seedSession(home, idOf(1), 1730000100000, 3, 20);
    seedSession(home, idOf(2), 1730000200000, 3, 24);
    const launch = join(home, ".agents", "learnings", "launch.log");
    mkdirSync(dirname(launch), { recursive: true });
    appendFileSync(launch, `${JSON.stringify({ source: `omp:${idOf(0)}` })}\n`);
    expect(await worstUnlearnedSource({ ...records(home), currentSessionId: idOf(2) })).toBe(next);
  });

  it("skips a session the chain's own annotated transcript or PM artifact already covers", async () => {
    const home = temp("artifact");
    seedSession(home, idOf(0), 1730000000000, 3, 25);
    const dir = join(home, "annotated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `omp_${idOf(0)}.learn-from-transcript.pm.jsonl`), `${"x".repeat(600)}\n`);
    await expect(worstUnlearnedSource(records(home))).rejects.toThrow(`no unlearned session among the youngest ${YOUNGEST_POOL}`);
    rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `omp_${idOf(0)}-0123456789abcdef.annotated.json`), "{}");
    await expect(worstUnlearnedSource(records(home))).rejects.toThrow("no unlearned session");
    // a PM artifact under the size bar did not run far enough to count
    rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `omp_${idOf(0)}.learn-from-transcript.pm.jsonl`), "tiny\n");
    expect(await worstUnlearnedSource(records(home))).toContain(idOf(0));
  });

  it("fails naming the pool size when nothing is selectable, and on a machine with no sessions at all", async () => {
    const home = temp("empty");
    await expect(worstUnlearnedSource(records(home))).rejects.toThrow(`no unlearned session among the youngest ${YOUNGEST_POOL}`);
    seedSession(home, idOf(0), 1730000000000, 1, 0, 1); // a probe: one human turn, one minute active
    await expect(worstUnlearnedSource(records(home))).rejects.toThrow(`no unlearned session among the youngest ${YOUNGEST_POOL}`);
  });

  it("considers only the youngest pool: a selectable session pushed past the edge is never picked", async () => {
    const home = temp("pool");
    seedSession(home, idOf(0), 1730000000000, 3, 25);
    for (let probe = 1; probe <= YOUNGEST_POOL; probe++) seedSession(home, idOf(probe), 1740000000000 + probe, 1, 0, 1);
    await expect(worstUnlearnedSource(records(home))).rejects.toThrow(`no unlearned session among the youngest ${YOUNGEST_POOL}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Filing and dispatch (ported from packages/ai/test/file_objectives.test.ts and tickets/objectives)
// ---------------------------------------------------------------------------------------------------------------

/** One scripted atask CLI: the registry `projects` lists, `add` files, and `refuse` answers refusals. */
function scriptedAtask(script: {
  projects?: Array<{ id: string; name: string }>;
  refuse?: (argv: string[]) => string | undefined;
  shows?: Record<string, { id: string; status: string }>;
  status?: (title: string) => string;
}): { run: RunAtask; calls: string[][] } {
  const calls: string[][] = [];
  let next = 0;
  const run: RunAtask = async (argv): Promise<AtaskRun> => {
    calls.push([...argv]);
    const [command] = argv;
    if (command === "projects") {
      return { code: 0, stdout: JSON.stringify({ ok: true, result: script.projects ?? [] }), stderr: "" };
    }
    if (command === "show") {
      const found = script.shows?.[argv[1]!];
      return found === undefined
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { message: "no task" } }), stderr: "" }
        : { code: 0, stdout: JSON.stringify({ ok: true, result: found }), stderr: "" };
    }
    if (command === "add") {
      const refusal = script.refuse?.([...argv]);
      if (refusal !== undefined) {
        return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "INVALID_INPUT", message: refusal } }), stderr: "" };
      }
      next++;
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: { task: { id: `at-${next}`, status: script.status?.(argv[1]!) ?? "ready" } } }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
  };
  return { run, calls };
}

const BOARD = [{ id: "proj-1", name: "capability-replicas" }];
const ROUTING = { title: "Name capability discovery before scripting a scraper" };

describe("fileObjectives through the atask CLI", () => {
  it("files a PM objective scoped to the real board its project names, exactly or by atask's name rule", async () => {
    const atask = scriptedAtask({ projects: BOARD });
    const filed = await fileObjectives(
      [
        { ...ROUTING, project: "capability-replicas" },
        { title: "Name the registry read in the routing instructions", project: "Capability Replicas" },
      ],
      ataskFilingPort(atask.run),
    );
    expect(atask.calls).toEqual([
      ["projects", "--json"],
      ["add", ROUTING.title, "--project", "proj-1", "--json"],
      ["add", "Name the registry read in the routing instructions", "--project", "proj-1", "--json"],
    ]);
    expect(filed.map((one) => [one.atask_id, one.status, one.filing])).toEqual([
      ["at-1", "ready", "created"],
      ["at-2", "ready", "created"],
    ]);
    expect(filed.every((one) => one.warning === undefined)).toBe(true);
    expect(filingHeadline(filed)).toBe("filed 2 objective(s) via the learn chain (forensics -> PM triage + review)");
  });

  it("files an objective whose project no board carries into atask's default project, recording the substitution", async () => {
    const atask = scriptedAtask({ projects: BOARD });
    const filed = await fileObjectives([{ title: "Fix the routing detour", project: "definitely-not-a-real-project" }], ataskFilingPort(atask.run));
    expect(atask.calls).toEqual([["projects", "--json"], ["add", "Fix the routing detour", "--json"]]);
    expect(filed[0]).toMatchObject({ atask_id: "at-1", status: "ready", filing: "created", project: "definitely-not-a-real-project" });
    expect(filed[0]!.warning).toContain('no single atask project answers "definitely-not-a-real-project"');
    expect(filed[0]!.warning).toContain("atask's default project");
  });

  it("passes a project id through without reading the registry, and passes proof and regression", async () => {
    const atask = scriptedAtask({});
    await fileObjectives(
      [{ title: "T", project: "proj-abc123", proof: "run: bun test a", regression: "run: bun test" }],
      ataskFilingPort(atask.run),
    );
    expect(atask.calls).toEqual([
      ["add", "T", "--project", "proj-abc123", "--json", "--proof", "run: bun test a", "--regression", "run: bun test"],
    ]);
  });

  it("surfaces a filing atask refuses as a refused objective, excluded from the headline count", async () => {
    const atask = scriptedAtask({
      projects: BOARD,
      refuse: ([, title]) => (title === "Fix the routing detour" ? "the board is read-only for this session" : undefined),
    });
    const filed = await fileObjectives(
      [{ ...ROUTING, project: "capability-replicas" }, { title: "Fix the routing detour", project: "capability-replicas" }],
      ataskFilingPort(atask.run),
    );
    expect(filed[0]).toMatchObject({ atask_id: "at-1", status: "ready" });
    expect(filed[1]).toMatchObject({ status: "unfiled" });
    expect(filed[1]!.atask_id).toBeUndefined();
    expect(filed[1]!.error).toContain("the board is read-only for this session");
    expect(filingHeadline(filed)).toBe(
      "filed 1 objective(s), 1 refused by atask, via the learn chain (forensics -> PM triage + review)",
    );
  });

  it("falls back to atask's default project when a resolved board stops existing before the add, recording it", async () => {
    const atask = scriptedAtask({
      projects: BOARD,
      refuse: ([, title, flag]) =>
        title === "Fix the routing detour" && flag === "--project" ? 'unknown project "proj-1"; registered projects: (none)' : undefined,
    });
    const filed = await fileObjectives([{ title: "Fix the routing detour", project: "capability-replicas" }], ataskFilingPort(atask.run));
    expect(atask.calls).toEqual([
      ["projects", "--json"],
      ["add", "Fix the routing detour", "--project", "proj-1", "--json"],
      ["add", "Fix the routing detour", "--json"],
    ]);
    expect(filed[0]).toMatchObject({ atask_id: "at-1", status: "ready", filing: "created" });
    expect(filed[0]!.warning).toContain('unknown project "proj-1"');
    expect(filed[0]!.warning).toContain("atask's default project");
  });

  it("files as a draft when atask rejects the checks, and says so in the warning", async () => {
    const atask = scriptedAtask({
      refuse: (argv) => (argv.includes("--proof") ? "the proof check does not parse" : undefined),
      status: () => "draft",
    });
    const filed = await fileObjectives([{ title: "T", proof: "bad", regression: "also bad" }], ataskFilingPort(atask.run));
    expect(atask.calls.map((call) => call.includes("--proof"))).toEqual([true, false]);
    expect(filed[0]).toMatchObject({ atask_id: "at-1", status: "draft", filing: "created" });
    expect(filed[0]!.warning).toContain("filed at-1 as a draft");
  });

  it("reads a named atask id first so a rerun files nothing twice, and falls back to the title when it is unknown", async () => {
    const atask = scriptedAtask({ shows: { "at-9": { id: "at-9", status: "claimed" } } });
    const filed = await fileObjectives(
      [{ title: "Existing", atask_id: "at-9" }, { title: "Gone", atask_id: "at-404" }],
      ataskFilingPort(atask.run),
    );
    expect(filed[0]).toMatchObject({ atask_id: "at-9", status: "claimed", filing: "existing" });
    expect(filed[1]).toMatchObject({ atask_id: "at-1", status: "ready", filing: "created" });
    expect(atask.calls.filter(([command]) => command === "add")).toEqual([["add", "Gone", "--json"]]);
  });

  it("names both failures when the id is unknown and the title filing fails too", async () => {
    const atask = scriptedAtask({ refuse: () => "no write access" });
    const [filed] = await fileObjectives([{ title: "T", atask_id: "at-404" }], ataskFilingPort(atask.run));
    expect(filed).toMatchObject({ status: "unfiled" });
    expect(filed!.error).toBe("no task; filing by title also failed: no write access");
  });

  it("refuses an atask answer that carries no task rather than inventing one", async () => {
    const run: RunAtask = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { task: {} } }), stderr: "" });
    const [filed] = await fileObjectives([{ title: "T" }], ataskFilingPort(run));
    expect(filed!.status).toBe("unfiled");
    expect(filed!.error).toContain("returned no task with an id and a status");
  });

  it("turns a missing atask binary into a refused objective naming the cause", async () => {
    const run: RunAtask = async () => ({ code: 1, stdout: "", stderr: "", spawnError: "spawn atask ENOENT" });
    const [filed] = await fileObjectives([{ title: "T" }], ataskFilingPort(run));
    expect(filed).toMatchObject({ status: "unfiled" });
    expect(filed!.error).toContain("atask CLI is not runnable: spawn atask ENOENT");
  });

  it("objectivesOf keeps the filing fields and drops empty ones", () => {
    expect(objectivesOf([{ title: "A", project: "p", proof: "x", regression: "y", linear_link: "https://l/1", atask_id: "at-1", extra: 1 }]))
      .toEqual([{ title: "A", project: "p", proof: "x", regression: "y", linear_link: "https://l/1", atask_id: "at-1" }]);
    expect(() => objectivesOf([{ project: "p" }])).toThrow("Objectives[0] has no title");
    expect(() => objectivesOf({})).toThrow("not an array");
  });
});

describe("execAtask", () => {
  const ran = (result: Partial<ExecResult>): ExecResult => ({ stdout: "", stderr: "", code: 0, killed: false, ...result });

  it("runs the atask binary with the argv array untouched, in the given directory, under the call's signal", async () => {
    const seen: Array<{ command: string; args: string[]; options: unknown }> = [];
    const exec: Exec = async (command, args, options) => {
      seen.push({ command, args, options });
      return ran({ stdout: "{}" });
    };
    const controller = new AbortController();
    const run = execAtask(exec, { cwd: "/work", signal: controller.signal });
    expect(await run(["add", "title; rm -rf /", "--json"])).toEqual({ code: 0, stdout: "{}", stderr: "" });
    expect(seen[0]).toMatchObject({
      command: "atask",
      args: ["add", "title; rm -rf /", "--json"],
      options: { cwd: "/work", timeout: 60_000, signal: controller.signal },
    });
  });

  it("maps a spawn failure, a timeout and an abort", async () => {
    const failing: Exec = async () => {
      throw new Error("spawn atask ENOENT");
    };
    expect(await execAtask(failing)(["list"])).toMatchObject({ spawnError: "spawn atask ENOENT" });
    const killed: Exec = async () => ran({ killed: true });
    expect((await execAtask(killed)(["list"])).stderr).toContain("atask list was killed after 60 s");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(execAtask(failing, { signal: controller.signal })(["list"])).rejects.toThrow("stop");
  });
});

const filed = (id: string, project: string | undefined, status = "ready"): FiledObjective => ({
  title: `Objective ${id}`,
  ...(project === undefined ? {} : { project }),
  atask_id: id,
  status,
  filing: "created",
});

describe("dispatchObjectives", () => {
  it("starts one worker per ready objective, serialized within a project and concurrent across projects", async () => {
    const events: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<StartAtaskTaskOutput>>();
    const start: StartTask = (input) => {
      events.push(`start ${input.id}`);
      const gate = Promise.withResolvers<StartAtaskTaskOutput>();
      gates.set(input.id!, gate);
      return gate.promise;
    };
    const finish = (id: string): void => {
      events.push(`end ${id}`);
      gates.get(id)!.resolve({ task_id: id, status: "settled" });
    };
    const done = dispatchObjectives(
      [filed("at-1", "Alpha"), filed("at-2", "alpha"), filed("at-3", "beta"), filed("at-4", undefined), filed("at-5", undefined)],
      start,
    );
    await Bun.sleep(0);
    // alpha's second objective waits for the first; beta and both unscoped objectives start at once.
    expect(events).toEqual(["start at-1", "start at-3", "start at-4", "start at-5"]);
    finish("at-1");
    await Bun.sleep(0);
    expect(events.at(-1)).toBe("start at-2");
    for (const id of ["at-2", "at-3", "at-4", "at-5"]) finish(id);
    const result = await done;
    expect(result.map((one) => one.delegated?.task_id)).toEqual(["at-1", "at-2", "at-3", "at-4", "at-5"]);
  });

  it("starts each worker with the defaults the start_atask_task bridge applies", async () => {
    const inputs: StartAtaskTaskInput[] = [];
    await dispatchObjectives([filed("at-1", "p")], async (input) => {
      inputs.push(input);
      return { task_id: "at-1", status: "running" };
    });
    expect(inputs).toEqual([{ id: "at-1", onComplete: "merge", add_dirs: [], timeout_s: 1800 }]);
  });

  it("skips every objective that is not ready, naming why, and starts no worker for it", async () => {
    const started: string[] = [];
    const objectives: FiledObjective[] = [
      filed("at-1", "p", "draft"),
      filed("at-2", "p", "claimed"),
      filed("at-3", "p", "complete"),
      { title: "Refused", status: "unfiled", error: "atask said no" },
      { title: "No id", status: "ready" },
    ];
    const result = await dispatchObjectives(objectives, async (input) => {
      started.push(input.id!);
      return { task_id: input.id!, status: "settled" };
    });
    expect(started).toEqual([]);
    expect(result.map((one) => one.skip)).toEqual([
      "atask filed at-1 as a draft: give it proof and regression, then dispatch it",
      "at-2 is already claimed by another session; this run does not attach to it",
      "at-3 is complete; only a ready objective starts a worker",
      "atask said no",
      "atask has no objective for this objective",
    ]);
  });

  it("answers a worker that throws as a failed run for that objective and keeps going", async () => {
    const result = await dispatchObjectives([filed("at-1", "p"), filed("at-2", "p")], async (input) => {
      if (input.id === "at-1") throw new Error("claim exploded");
      return { task_id: "at-2", status: "settled" };
    });
    expect(result[0]!.delegated).toEqual({ task_id: "at-1", status: "failed", error: "claim exploded" });
    expect(result[1]!.delegated?.status).toBe("settled");
  });

  it("groups unscoped objectives into their own lanes and scoped ones by trimmed, lower-cased project", () => {
    const lanes = groupByProjectLane([
      [filed("a", " Proj "), 0],
      [filed("b", undefined), 1],
      [filed("c", "proj"), 2],
      [filed("d", ""), 3],
    ]);
    expect(lanes.map((lane) => lane.map(([one]) => one.atask_id))).toEqual([["a", "c"], ["b"], ["d"]]);
  });

  it("runs the start_atask_task lifecycle it was copied with: a draft is refused, a complete task lands through wt merge", async () => {
    const merged: Array<[string, string | undefined]> = [];
    const snapshots: Record<string, { id: string; status: string; title?: string; attempt?: { workspace: string; branch: string } }> = {
      "at-1": { id: "at-1", status: "draft" },
      "at-2": { id: "at-2", status: "complete", title: "Fix it", attempt: { workspace: "/ws/at-2", branch: "atask/at-2" } },
    };
    const never = async (): Promise<never> => {
      throw new Error("not used by this path");
    };
    const start: StartTask = (input) =>
      startAtaskTask(input, {
        atask: {
          show: async (id) => snapshots[id]!,
          claim: never,
          assign: never,
          renew: never,
          verifyComplete: never,
          projectTarget: async () => "main",
        },
        worker: { start: never, status: never, stop: () => "unknown" },
        wt: { merge: async (workspace, target) => (merged.push([workspace, target]), "merged") },
        git: { push: never, contains: never, abortRebase: never },
        gh: { createPullRequest: never, armAutoMerge: never },
        workspaceExists: async () => true,
      });
    const result = await dispatchObjectives([filed("at-1", undefined), filed("at-2", undefined)], start);
    expect(result[0]!.delegated).toMatchObject({ task_id: "at-1", status: "refused" });
    expect(result[0]!.delegated!.error).toContain("is a draft");
    expect(result[1]!.delegated).toMatchObject({ task_id: "at-2", status: "settled", completion: { on_complete: "merge", outcome: "merged" } });
    expect(merged).toEqual([["/ws/at-2", undefined]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The agent step and the thread
// ---------------------------------------------------------------------------------------------------------------

describe("ompAgentStep", () => {
  const ran = (result: Partial<ExecResult>): ExecResult => ({ stdout: "", stderr: "", code: 0, killed: false, ...result });

  it("runs a FULL omp session over a private prompt file, reads the answer file it wrote, and removes the directory", async () => {
    let promptFile = "";
    let answerFile = "";
    let argvSeen: string[] = [];
    const exec: Exec = async (command, args, options) => {
      expect(command).toBe("omp");
      argvSeen = args;
      promptFile = args[args.indexOf("-p") + 1]!.slice(1);
      const prompt = readFileSync(promptFile, "utf8");
      answerFile = /to this file: (\S+)/.exec(prompt)![1]!;
      expect(options).toMatchObject({ cwd: "/work", timeout: 5_000 });
      writeFileSync(answerFile, '{"RootCauses":[]}');
      return ran({});
    };
    const step = ompAgentStep(exec, { cwd: "/work", timeoutMs: 5_000, addDirs: ["/extra"] });
    const text = await step({ prompt: (file) => `ANSWER to this file: ${file}` });
    expect(text).toBe('{"RootCauses":[]}');
    expect(argvSeen).toEqual([
      "--auto-approve", "--model", "@task", "--add-dir", dirname(promptFile), "--add-dir", "/extra", "-p", `@${promptFile}`,
    ]);
    // a full session: none of the bare flags the model-only step passes
    for (const bare of ["--no-tools", "--no-session", "--no-extensions", "--no-skills"]) expect(argvSeen).not.toContain(bare);
    expect(existsSync(dirname(promptFile))).toBe(false);
    expect(answerFile.startsWith(dirname(promptFile))).toBe(true);
  });

  it("fails on a kill, a non-zero exit, a session that wrote nothing and an empty file; the temp dir never leaks", async () => {
    const dirs: string[] = [];
    const scripted = (result: ExecResult, write?: string): Exec => async (_c, args) => {
      const file = args[args.indexOf("-p") + 1]!.slice(1);
      dirs.push(dirname(file));
      if (write !== undefined) writeFileSync(join(dirname(file), "answer.json"), write);
      return result;
    };
    const ask = (e: Exec) => ompAgentStep(e, { timeoutMs: 1_000 })({ prompt: () => "p" });
    await expect(ask(scripted(ran({ killed: true })))).rejects.toThrow("killed after 1 s");
    await expect(ask(scripted(ran({ code: 2, stderr: "boom" })))).rejects.toThrow("exited 2: boom");
    const missing = ask(scripted(ran({ stdout: "I could not finish" })));
    await expect(missing).rejects.toBeInstanceOf(AnswerMissing);
    await expect(ask(scripted(ran({ stdout: "I could not finish" })))).rejects.toThrow("its last words: I could not finish");
    await expect(ask(scripted(ran({}), "  \n"))).rejects.toThrow("empty answer file");
    expect(dirs.length).toBe(5);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("stops before spawning when already aborted", async () => {
    let spawned = false;
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      ompAgentStep(async () => ((spawned = true), ran({})))({ prompt: () => "p", signal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(spawned).toBe(false);
  });

  it("parses the answer file as JSON or as the one fenced block that is the whole file, and nothing else", () => {
    expect(parseAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseAnswer('Here you go: {"a":1}')).toThrow("not JSON");
  });
});

/** The question name a session prompt asks: its `# The question to answer now (Name)` heading. */
const FIELD_OF: Record<string, string> = { analyze: "Analysis", root_cause: "RootCauses", pm_triage: "PmTriage", pm_review: "Objectives" };
const questionOf = (prompt: string): string => FIELD_OF[/# The question to answer now \((\w+)\)/.exec(prompt)![1]!]!;
const answerFileOf = (prompt: string): string => /to this file: (\S+)/.exec(prompt)![1]!;

/** A scripted agent: the answer per question field, or a function of the attempt, recording every prompt it was shown. */
class FakeAgent {
  readonly prompts: Array<{ question: string; text: string }> = [];
  constructor(private readonly answers: Record<string, unknown | ((attempt: number) => unknown)>) {}
  readonly step: AgentStep = async (request: AgentRequest) => {
    const text = request.prompt("/tmp/answer.json");
    const question = questionOf(text);
    const attempt = this.prompts.filter((entry) => entry.question === question).length + 1;
    this.prompts.push({ question, text });
    const scripted = this.answers[question];
    const value = typeof scripted === "function" ? (scripted as (n: number) => unknown)(attempt) : scripted;
    if (value instanceof Error) throw value;
    return JSON.stringify({ [question]: value });
  };
  get questions(): string[] {
    return this.prompts.map((entry) => entry.question);
  }
}

const ANALYSIS = {
  finding: {
    execution_ref: "omp:fake",
    outcome: { requested: "Land the fix.", achieved: "It landed.", verified: true },
    family: ["other:tool-routing"],
    assertions: [
      {
        id: "A1",
        claim: "The agent scripted a scraper the catalog already owns.",
        status: "observed",
        evidence: [{ ref: "item:7" }],
        mechanism: "No instruction asks for a catalog lookup before scripting.",
        disproof: "A run that calls firecrawl_scrape unprompted.",
        layer: "tool-wiring",
      },
      {
        id: "A2",
        claim: "The detour recurred twice in the session.",
        status: "observed",
        evidence: [{ ref: "item:9" }],
        mechanism: "The failure class has no guard.",
        disproof: "A single-detour session.",
        layer: "instructions",
      },
    ],
    tas: {
      earliest_divergence: { assertion: "A1", ref: "item:7" },
      dominant_cause: { assertion: "A1", ref: "item:7" },
    },
  },
  hypothesis: {
    layer: "instructions",
    fix_kind: "adjust-instructions",
    change: "Name capability discovery in the routing instructions.",
    control: "The current routing instructions.",
    treatment: "The same instructions plus the discovery step.",
    constants: ["model tier"],
    oracle: "The session reaches firecrawl_scrape directly.",
    prediction: "The detour disappears on replay.",
    falsification: "The agent scripts a scraper again.",
    prior_art: [],
    prior_art_search_note: "Searched AGENTS.md and the capability catalog; no discovery rule exists.",
    readiness: "runnable",
  },
};

const YIELDS = {
  Analysis: ANALYSIS,
  RootCauses: [
    {
      cause: "The catalog lookup is not named anywhere before scripting.",
      evidence: "item:7 scripted the scraper in one turn.",
      fix: "Add the discovery step to the routing instructions.",
    },
  ],
  PmTriage: [
    {
      title: "Name capability discovery before scripting a scraper",
      priority: 2,
      invariant: "The routing instructions name the catalog lookup.",
      proof: "run: bun test test/routing.test.ts",
      regression: "run: bun test",
    },
  ],
  Objectives: [
    {
      title: "Name capability discovery before scripting a scraper",
      project: "capability-replicas",
      proof: "run: bun test test/routing.test.ts",
      regression: "run: bun test",
      linear_link: "https://linear.app/personal/issue/ZYS-1",
    },
  ],
};

describe("thread", () => {
  const options = (path: string, agent: AgentStep, extra: Partial<Parameters<typeof openThread>[0]> = {}) => ({
    path,
    role: "execution-forensics",
    preamble: "You are the forensics analyst.",
    agent,
    loadQuestions: (name: string) => loadQuestionFile(name),
    turns: new RunTurns(),
    ...extra,
  });

  it("shows each session the role, the earlier questions and answers, the question, its schema and the answer file", async () => {
    const dir = temp("thread");
    const agent = new FakeAgent(YIELDS);
    const thread = openThread(options(join(dir, "t.jsonl"), agent.step));
    await thread.prompt("analyze", { transcript: "/t/s.annotated.json" });
    await thread.prompt("root_cause");
    const [first, second] = agent.prompts.map((entry) => entry.text);
    expect(first).toStartWith("You are the forensics analyst.");
    expect(first).toContain("Here's a transcript to review: /t/s.annotated.json");
    expect(first).not.toContain("# The conversation so far");
    expect(first).toContain("The file is the only channel");
    expect(first).toContain('"required": [\n    "Analysis"\n  ]');
    expect(second).toContain("# The conversation so far");
    expect(second).toContain("## Question 1 (analyze)");
    expect(second).toContain("The detour recurred twice in the session.");
    expect(second).toContain("I feel like your answer is superficial.");
    expect(answerFileOf(second!)).toBe("/tmp/answer.json");
    const stored = readFileSync(join(dir, "t.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(stored[0]!)).toEqual({ type: "thread", role: "execution-forensics" });
    expect(stored).toHaveLength(3);
  });

  it("replays stored turns whose prompt matches instead of asking again, and re-asks from the turn that changed", async () => {
    const dir = temp("replay");
    const path = join(dir, "t.jsonl");
    const agent = new FakeAgent(YIELDS);
    const run = async (transcript: string) => {
      const thread = openThread(options(path, agent.step));
      await thread.prompt("analyze", { transcript });
      return await thread.prompt("root_cause");
    };
    const first = await run("/t/a.annotated.json");
    expect(agent.questions).toEqual(["Analysis", "RootCauses"]);
    expect(await run("/t/a.annotated.json")).toEqual(first);
    expect(agent.questions).toHaveLength(2); // no model call on the second run
    await run("/t/grown-session.annotated.json");
    expect(agent.questions).toEqual(["Analysis", "RootCauses", "Analysis", "RootCauses"]);
  });

  it("stops replaying every later thread of the run once one turn diverged", async () => {
    const dir = temp("diverge");
    const agent = new FakeAgent(YIELDS);
    const turns = new RunTurns();
    const first = openThread(options(join(dir, "a.jsonl"), agent.step, { turns }));
    await first.prompt("analyze", { transcript: "/a" });
    const second = openThread(options(join(dir, "b.jsonl"), agent.step, { turns }));
    await second.prompt("root_cause");
    // a stored b.jsonl turn would match now, but the run already diverged in thread a
    const rerunTurns = new RunTurns();
    const again = openThread(options(join(dir, "b.jsonl"), agent.step, { turns: rerunTurns }));
    rerunTurns.diverge();
    await again.prompt("root_cause");
    expect(agent.questions).toEqual(["Analysis", "RootCauses", "RootCauses"]);
  });

  it("asks again with the refusal and the rejected answer shown, then accepts the corrected one", async () => {
    const dir = temp("reask");
    const agent = new FakeAgent({
      ...YIELDS,
      RootCauses: (attempt: number) => (attempt === 1 ? [{ cause: "only a cause" }] : YIELDS.RootCauses),
    });
    const reports: string[] = [];
    const thread = openThread(options(join(dir, "t.jsonl"), agent.step, { report: (message) => reports.push(message) }));
    const answer = await thread.prompt("root_cause");
    expect(answer.RootCauses).toEqual(YIELDS.RootCauses);
    expect(agent.questions).toEqual(["RootCauses", "RootCauses"]);
    const retry = agent.prompts[1]!.text;
    expect(retry).toContain("# Your previous attempt was rejected");
    expect(retry).toContain("RootCauses[0] is missing evidence");
    expect(retry).toContain("only a cause");
    expect(reports).toContain("execution-forensics: root_cause (attempt 2 of 3)");
  });

  it("fails with the reason after the attempts are spent and stores nothing for the rejected answer", async () => {
    const dir = temp("reject");
    const path = join(dir, "t.jsonl");
    const agent = new FakeAgent({ Objectives: [{ project: "capability-replicas" }] }); // no title
    const thread = openThread(options(path, agent.step, { attempts: 2 }));
    await expect(thread.prompt("pm_review")).rejects.toThrow(
      "pm_review: answer rejected after 2 attempts: answer rejected: Objectives[0] is missing title",
    );
    expect(agent.questions).toHaveLength(2);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1); // the header alone
  });

  it("asks again when the session wrote no answer file, but never when the session itself crashed", async () => {
    const dir = temp("missing");
    let calls = 0;
    const flaky: AgentStep = async () => {
      calls++;
      if (calls === 1) throw new AnswerMissing("the session finished without writing its answer");
      return JSON.stringify({ RootCauses: YIELDS.RootCauses });
    };
    const ok = openThread(options(join(dir, "a.jsonl"), flaky));
    expect((await ok.prompt("root_cause")).RootCauses).toEqual(YIELDS.RootCauses);
    expect(calls).toBe(2);

    let crashed = 0;
    const crash: AgentStep = async () => {
      crashed++;
      throw new Error("agent session exited 1: auth expired");
    };
    const failing = openThread(options(join(dir, "b.jsonl"), crash));
    await expect(failing.prompt("root_cause")).rejects.toThrow("root_cause: agent session exited 1: auth expired");
    expect(crashed).toBe(1);
  });

  it("stops before the next session when aborted", async () => {
    const dir = temp("abort");
    const controller = new AbortController();
    controller.abort(new Error("user stopped"));
    const agent = new FakeAgent(YIELDS);
    const thread = openThread(options(join(dir, "t.jsonl"), agent.step, { signal: controller.signal }));
    await expect(thread.prompt("root_cause")).rejects.toThrow("user stopped");
    expect(agent.prompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The chain (ported from packages/ai/test/learn_from_transcript.test.ts)
// ---------------------------------------------------------------------------------------------------------------

function writeSource(root: string, text: string): string {
  const path = join(root, "session.json");
  writeFileSync(
    path,
    JSON.stringify({
      conversation: "omp:fake",
      source: path,
      turns: [{ user: [{ id: 1, text }], response: [{ id: 2, source: "agent", text: "done", tool_calls: [] }] }],
    }),
  );
  return path;
}

describe("learnFromTranscript", () => {
  let root: string;
  let savedAnnotatedDir: string | undefined;
  const started: StartAtaskTaskInput[] = [];
  const noTranscripts: TurnSource = {
    async readTurns(conversation) {
      throw new Error(`${conversation}: no host transcript source in this test`);
    },
  };

  beforeEach(() => {
    root = temp("chain");
    savedAnnotatedDir = process.env.CAPABILITY_ANNOTATED_DIR;
    process.env.CAPABILITY_ANNOTATED_DIR = join(root, "annotated");
    started.length = 0;
  });
  afterEach(() => {
    if (savedAnnotatedDir === undefined) delete process.env.CAPABILITY_ANNOTATED_DIR;
    else process.env.CAPABILITY_ANNOTATED_DIR = savedAnnotatedDir;
  });

  const depsFor = (agent: FakeAgent, atask: { run: RunAtask }, extra: Partial<LearnDeps> = {}): LearnDeps => ({
    agent: agent.step,
    atask: atask.run,
    startTask: async (input): Promise<StartAtaskTaskOutput> => {
      started.push(input);
      return { task_id: input.id!, status: "settled" };
    },
    transcripts: noTranscripts,
    agentDir: root,
    preambles: { forensics: "You are execution-forensics.", pm: "You are forensic-pm." },
    records: { home: join(root, "home"), annotatedDir: join(root, "annotated") },
    ...extra,
  });

  it("files objectives but starts no worker when dispatch is false", async () => {
    const source = writeSource(root, "one session with a detour");
    const agent = new FakeAgent(YIELDS);
    const atask = scriptedAtask({ projects: BOARD });
    const result = await learnFromTranscript({ source, dispatch: false }, depsFor(agent, atask));

    expect(agent.questions).toEqual(["Analysis", "RootCauses", "PmTriage", "Objectives"]);
    expect(result.objectives).toHaveLength(1);
    expect(result.objectives[0]).toMatchObject({
      title: "Name capability discovery before scripting a scraper",
      status: "ready",
      atask_id: "at-1",
      filing: "created",
    });
    expect(result.headline).toBe("filed 1 objective(s) via the learn chain (forensics -> PM triage + review)");
    expect(result.source).toBe(source);
    expect(result.source_picked).toBe(false);
    expect(atask.calls.filter(([command]) => command === "add")).toHaveLength(1);
    expect(started).toHaveLength(0);
    expect("delegated" in result.objectives[0]!).toBe(false);
  });

  it("annotates the session without a model and hands the forensics the annotated file; the PM reads the forensics thread", async () => {
    const source = writeSource(root, "one session with a detour");
    const agent = new FakeAgent(YIELDS);
    const result = await learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD })));
    expect(result.annotated_path.startsWith(join(root, "annotated"))).toBe(true);
    expect(result.annotated_path).toMatch(/\.annotated\.json$/);
    expect(JSON.parse(readFileSync(result.annotated_path, "utf8")).turns[0].user[0].annotation).toBeDefined();
    expect(agent.prompts[0]!.text).toContain(`Here's a transcript to review: ${result.annotated_path}`);
    expect(agent.prompts[2]!.text).toContain(`session transcript at ${result.forensics_thread}`);
    // each thread opens with its own agent definition's instructions
    expect(agent.prompts[0]!.text).toStartWith("You are execution-forensics.");
    expect(agent.prompts[2]!.text).toStartWith("You are forensic-pm.");
    expect(result.forensics_thread).toMatch(/threads\/learn_from_transcript-[0-9a-f]{16}-t0\.jsonl$/);
    expect(result.pm_thread).toMatch(/-t1\.jsonl$/);
    expect(existsSync(result.pm_thread)).toBe(true);
  });

  it("starts one worker per filed objective when dispatch is true", async () => {
    const source = writeSource(root, "one session with a detour");
    const result = await learnFromTranscript(
      { source, dispatch: true },
      depsFor(new FakeAgent(YIELDS), scriptedAtask({ projects: BOARD })),
    );
    const [only] = result.objectives as DelegatedObjective[];
    expect(only!.delegated?.task_id).toBe("at-1");
    expect(started.map((input) => input.id)).toEqual(["at-1"]);
  });

  it("does not start a worker for a draft and says why", async () => {
    const source = writeSource(root, "one session with a detour");
    const result = await learnFromTranscript(
      { source, dispatch: true },
      depsFor(new FakeAgent(YIELDS), scriptedAtask({ projects: BOARD, status: () => "draft" })),
    );
    expect(started).toHaveLength(0);
    expect((result.objectives[0] as DelegatedObjective).skip).toContain("filed at-1 as a draft");
  });

  it("replays completed turns with matching prompts instead of asking again", async () => {
    const source = writeSource(root, "one session with a detour");
    const agent = new FakeAgent(YIELDS);
    const first = await learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD })));
    expect(agent.prompts).toHaveLength(4);
    const second = await learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD })));
    expect(agent.prompts).toHaveLength(4); // no model call on the second run
    expect(second).toEqual(first);
  });

  it("re-asks from the turn whose prompt changed when the transcript grows", async () => {
    const source = writeSource(root, "one session with a detour");
    const agent = new FakeAgent(YIELDS);
    await learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD })));
    expect(agent.prompts).toHaveLength(4);
    writeSource(root, "one session with a detour, now grown with a second failure");
    await learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD })));
    expect(agent.prompts.length).toBe(8); // the grown transcript renders a different prompt: all four turns re-asked
    expect(agent.prompts[4]!.question).toBe("Analysis");
    expect(agent.prompts[4]!.text).not.toBe(agent.prompts[0]!.text);
  });

  it("rejects a schema-invalid answer", async () => {
    const source = writeSource(root, "one session with a detour");
    const agent = new FakeAgent({ ...YIELDS, Objectives: [{ project: "capability-replicas" }] });
    await expect(
      learnFromTranscript({ source, dispatch: false }, depsFor(agent, scriptedAtask({ projects: BOARD }))),
    ).rejects.toThrow(/pm_review: answer rejected after 3 attempts/);
  });

  it("passes empty objectives through without filing or starting anything", async () => {
    const source = writeSource(root, "a clean session");
    const atask = scriptedAtask({ projects: BOARD });
    const result = await learnFromTranscript({ source, dispatch: true }, depsFor(new FakeAgent({ ...YIELDS, Objectives: [] }), atask));
    expect(result.objectives).toEqual([]);
    expect(result.headline).toBe("the PM review found no objective to file");
    expect(atask.calls).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("picks the worst unlearned session itself when no source is named, and reports that it did", async () => {
    const home = join(root, "home");
    const worst = seedSession(home, idOf(0), 1730000000000, 3, 25);
    seedSession(home, idOf(1), 1730000100000, 2, 1, 5);
    const agent = new FakeAgent(YIELDS);
    const reports: string[] = [];
    const result = await learnFromTranscript(
      { dispatch: false },
      depsFor(agent, scriptedAtask({ projects: BOARD }), { report: (message) => reports.push(message) }),
    );
    expect(result.source).toBe(worst);
    expect(result.source_picked).toBe(true);
    expect(agent.questions).toEqual(["Analysis", "RootCauses", "PmTriage", "Objectives"]);
    expect(reports).toContain(`no source named; learning from the worst unlearned session: ${worst}`);
    // the annotated transcript the run wrote now marks the session learned: the next pick skips it
    await expect(worstUnlearnedSource({ home, annotatedDir: join(root, "annotated") })).resolves.toContain(idOf(1));
  });

  it("fails before any model call when the source cannot be read", async () => {
    const agent = new FakeAgent(YIELDS);
    await expect(
      learnFromTranscript({ source: join(root, "nothing.json"), dispatch: false }, depsFor(agent, scriptedAtask({}))),
    ).rejects.toThrow("is not a conversation ref");
    expect(agent.prompts).toHaveLength(0);
  });

  it("loads the shipped preambles for both agent definitions", async () => {
    const preambles = await loadPreambles();
    expect(preambles.forensics).toContain("Execution Forensics Analyst");
    expect(preambles.pm).toContain("You are the **Stage 2 Forensic PM Agent**");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The tool surface
// ---------------------------------------------------------------------------------------------------------------

describe("tool surface", () => {
  it("has a 80-250 word imperative description that states the effects and the boundary, and no absolute home path", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const phrase of ["spends model quota", "files atask objectives", "extract_hypotheses", "`learn`", "Mastra chat-thread refs are NOT supported"]) {
      expect(DESCRIPTION).toContain(phrase);
    }
    expect(DESCRIPTION).not.toContain("/Users/");
  });

  it("renders the filed objectives with their atask fields, worker runs and skip reasons", () => {
    const text = resultText({
      source: "/s.jsonl",
      source_picked: true,
      annotated_path: "/a.json",
      forensics_thread: "/t0",
      pm_thread: "/t1",
      dispatch: true,
      headline: "filed 2 objective(s) via the learn chain (forensics -> PM triage + review)",
      objectives: [
        { ...filed("at-1", "p"), delegated: { task_id: "at-1", status: "settled", branch: "atask/at-1", completion: { on_complete: "merge", outcome: "merged" } } },
        { ...filed("at-2", "p", "draft"), skip: "atask filed at-2 as a draft" },
      ],
    });
    expect(text).toContain("source: /s.jsonl (picked)");
    expect(text).toContain("- at-1 | ready | Objective at-1 | [p]");
    expect(text).toContain("worker: settled on atask/at-1, landing merged");
    expect(text).toContain("no worker: atask filed at-2 as a draft");
  });

  it("builds a discoverable tool whose parameters take the source and dispatch as null-able options", () => {
    const calls: string[] = [];
    const chain = (name: string) => {
      const node: Record<string, unknown> = {};
      for (const method of ["nullable", "optional", "describe"]) {
        node[method] = () => {
          calls.push(`${name}.${method}`);
          return node;
        };
      }
      return node;
    };
    const zod = {
      string: () => chain("string"),
      boolean: () => chain("boolean"),
      object: (shape: Record<string, unknown>) => ({ shape }),
    };
    const tool = factory({ zod, exec: async () => ({}), cwd: "/work" } as never) as unknown as {
      name: string;
      loadMode: string;
      description: string;
      parameters: { shape: Record<string, unknown> };
    };
    expect(tool.name).toBe("learn_from_transcript");
    expect(tool.loadMode).toBe("discoverable");
    expect(Object.keys(tool.parameters.shape)).toEqual(["source", "dispatch"]);
    expect(calls).toEqual([
      "string.nullable", "string.optional", "string.describe",
      "boolean.nullable", "boolean.optional", "boolean.describe",
    ]);
  });
});
