import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { ataskAddArguments } from "./apply.js";
import { chooserPrompt, ENTRY_LIMIT, parseChoice } from "./choose_project.js";
import { TEST_FILE_PATHSPECS } from "./define_objective/checkout_tests.js";
import type { Machine, ProcessResult } from "./define_objective/machine.js";
import { pathsNamedBy } from "./define_objective/checked_paths.js";
import factory from "./index.js";
import { type Exec, type ModelStep } from "./omp_model.js";
import { planGoals, plannedItems, prerequisites, type SpecifiedGoal } from "./plan.js";
import { runPlanTasks, SPEC_CONCURRENCY } from "./plan_tasks.js";
import type { PlannedItem } from "./types.js";

// ---- the world: a Go project registered in atask, and a scripted machine over it
const HOME = "/p/agentmux";
const G1 = "select_model ranks ollama/nimble last when TypeSafe is reachable";
const G2 = "ranked models keep their order";
const TEXT = `Make ${G1}. Also ${G2}.`;
const PIECES = [`Make ${G1}.`, `Also ${G2}.`];

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
const registry = {
  ok: true,
  result: [
    { id: "proj-1", name: "agentmux", root_path: HOME },
    { id: "proj-2", name: "general" },
  ],
};
const addedTask = (id: string): ProcessResult => ok(JSON.stringify({ ok: true, result: { task: { id } } }));

class FakeMachine implements Machine {
  readonly runs: { commandLine: string; env: Readonly<Record<string, string>> }[] = [];
  readonly homeDirectory = "/home/zach";
  private readonly files: Map<string, string>;
  constructor(
    private readonly commands: Record<string, ProcessResult | ((commandLine: string) => ProcessResult)> = {},
    files: Record<string, string> = {},
    private readonly directories: string[] = [],
  ) {
    this.files = new Map(Object.entries({
      [`${HOME}/README.md`]: "# agentmux\n\nDelegates work to coding agents.\n",
      [`${HOME}/go.mod`]: "module example.com/agentmux\n",
      [`${HOME}/mise.toml`]: '[tasks.test]\nrun = "go test ./..."\n',
      [`${HOME}/internal/capability/ranked_models_test.go`]:
        "func TestRankedModelsPutLocalLast(t *testing.T) {}\nfunc TestRankedModelsKeepOrder(t *testing.T) {}\n",
      ...files,
    }));
  }
  async run(command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ");
    this.runs.push({ commandLine, env });
    const answer = this.commands[commandLine];
    if (answer === undefined) return { code: 127, stdout: "", stderr: `no fake for ${commandLine}` };
    return typeof answer === "function" ? answer(commandLine) : answer;
  }
  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async isDirectory(path: string): Promise<boolean> {
    return (await this.listDirectory(path)).length > 0 || this.directories.includes(path);
  }
  async isFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async listDirectory(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/+$/, "")}/`;
    const below = [...this.files.keys(), ...this.directories].filter((entry) => entry.startsWith(prefix));
    return [...new Set(below.map((entry) => entry.slice(prefix.length).split("/")[0]!))].sort();
  }
  ataskAdds(): string[] {
    return this.runs.map((run) => run.commandLine).filter((line) => line.startsWith("atask add"));
  }
}

const projectCommands = (extra: Record<string, ProcessResult | ((commandLine: string) => ProcessResult)> = {}) => ({
  "atask projects": ok(JSON.stringify(registry)),
  "atask --project proj-1 list open": ok(JSON.stringify({ ok: true, result: { tasks: [{ id: "at-1", title: "Something else entirely here" }] } })),
  [`git -C ${HOME} ls-files -- ${TEST_FILE_PATHSPECS.join(" ")}`]: ok("internal/capability/ranked_models_test.go\n"),
  ...extra,
});
const machineOf = (extra: Parameters<typeof projectCommands>[0] = {}, files: Record<string, string> = {}) =>
  new FakeMachine(projectCommands(extra), files, [`${HOME}/internal`]);

// ---- the model: one fake that answers every kind of prompt the tool sends
const INTENT_ANSWERS = {
  Atomic: "atomic", Type: "task", Intent: "implementation", ModelStrength: 1, SoftwareImplementation: true,
  SoftwareArchitecture: false, DifficultDebugging: false, Research: false, Ambiguity: false, LongHorizon: false,
};
const GOAL_ANSWERS = { Role: "request", Explicit: true, Verifiable: true, Urgency: "now", Scope: "single_change" };

const spec = (change: Record<string, unknown>) => ({
  title: "Rank local models last when TypeSafe answers",
  outcome: "Local models rank after TypeSafe when TypeSafe answers.",
  acceptance: ["ollama/nimble is ranked after every API model"],
  draft: false,
  draft_reason: "",
  proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast",
  regression: "go_test: ./internal/capability",
  regression_size: "medium",
  rationale: "The named test fails while nimble ranks first.",
  ...change,
});
const SPEC_1 = spec({});
const SPEC_2 = spec({
  title: "Keep ranked models in their given order",
  outcome: "Ranked models keep the order they were given.",
  acceptance: ["The ranked list preserves input order"],
  proof: "go_test: ./internal/capability name=TestRankedModelsKeepOrder",
  rationale: "The named test fails when order is shuffled.",
});

interface World {
  /** Replies to the objective prompt of each goal, in order; the last one repeats. */
  specs?: Record<string, Record<string, unknown>[]>;
  /** `order` for the pair (earlier goal text, later goal text): the model's category and probability. */
  pair?: { choice: string; probability?: number };
  /** Answers to the project chooser. */
  project?: string;
  goalsFail?: Error;
  pieces?: string[];
}

const listedIds = (prompt: string): string[] => [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]!);

function fakeModel(world: World = {}) {
  const prompts: string[] = [];
  const asked = new Map<string, number>();
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("## Pieces")) return JSON.stringify({ Pieces: world.pieces ?? PIECES });
    if (prompt.startsWith("## Goals")) {
      if (world.goalsFail) throw world.goalsFail;
      const [first, second] = listedIds(prompt);
      return JSON.stringify({ Goals: [{ outcome: G1, sources: [first] }, { outcome: G2, sources: [second] }] });
    }
    if (prompt.startsWith("## ObjectiveSpec")) {
      const goal = /^The goal: (.*)$/m.exec(prompt)![1]!;
      const queue = world.specs?.[goal] ?? [goal === G1 ? SPEC_1 : SPEC_2];
      const n = asked.get(goal) ?? 0;
      asked.set(goal, n + 1);
      return JSON.stringify({ ObjectiveSpec: queue[Math.min(n, queue.length - 1)] });
    }
    if (prompt.startsWith("## Project")) return JSON.stringify({ Project: world.project ?? "agentmux" });
    if (prompt.startsWith("## classification")) {
      const pair = world.pair ?? { choice: "independent" };
      return JSON.stringify({ classification: pair.choice, probability: pair.probability ?? 0.95 });
    }
    return JSON.stringify(prompt.includes("## Role") ? GOAL_ANSWERS : INTENT_ANSWERS);
  };
  return {
    step,
    prompts,
    of: (lead: string) => prompts.filter((prompt) => prompt.startsWith(lead)),
    objectiveFor: (goal: string) => prompts.filter((prompt) => prompt.startsWith("## ObjectiveSpec") && prompt.includes(`The goal: ${goal}\n`)),
  };
}

const plan = (
  input: { text?: string; project?: string; apply?: boolean },
  model: { step: ModelStep },
  machine: Machine = machineOf(),
  extra: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {},
) => runPlanTasks({ text: TEXT, ...input }, { step: model.step, machine, cwd: "/work", ...extra });

describe("plan_tasks composition", () => {
  it("identifies the goals, writes one grounded item per goal in the order the words state them, and orders them", async () => {
    const model = fakeModel();
    const result = await plan({ project: "agentmux" }, model);
    expect(result.project).toEqual({ id: "proj-1", name: "agentmux", needsNewProject: false });
    expect(result.applied).toEqual([]);
    expect(result.items.map((item) => [item.key, item.title, item.goal])).toEqual([
      ["t1", SPEC_1.title, G1],
      ["t2", SPEC_2.title, G2],
    ]);
    expect(result.items[0]).toMatchObject({
      proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small",
      regression: "go_test: ./internal/capability size=medium",
      draft: false,
      requires: [],
    });
    expect(result.items.every((item) => item.sources.length === 1)).toBe(true);
    // no project chooser when the project is named; the one pair of goals is judged once
    expect(model.of("## Project")).toHaveLength(0);
    expect(model.of("## classification")).toHaveLength(1);
    expect(model.of("## ObjectiveSpec")).toHaveLength(2);
  });

  it("shows each objective writer the project's home, goal, files and open tasks, and the sibling goals", async () => {
    const model = fakeModel();
    await plan({ project: "proj-1" }, model);
    const prompt = model.objectiveFor(G1)[0]!;
    expect(prompt).toContain(`Project: agentmux\nProject home: ${HOME}\nProject goal: Delegates work to coding agents.`);
    expect(prompt).toContain("- go in the project root (example.com/agentmux): go test");
    expect(prompt).toContain("Open tasks already filed (do not repeat them):\n- at-1 Something else entirely here");
    expect(prompt).toContain(`Other goals alongside (not part of this one):\n- ${G2}`);
    expect(prompt).not.toContain(`- ${G1}`);
  });

  it("an item whose goal the judge puts after the other requires it, and items keep prerequisites first", async () => {
    const forward = await plan({ project: "agentmux" }, fakeModel({ pair: { choice: "a_before_b" } }));
    expect(forward.items.map((item) => [item.key, item.requires])).toEqual([["t1", []], ["t2", ["t1"]]]);
    const backward = await plan({ project: "agentmux" }, fakeModel({ pair: { choice: "b_before_a" } }));
    expect(backward.items.map((item) => [item.key, item.requires])).toEqual([["t2", []], ["t1", ["t2"]]]);
  });

  it("an unsure pair guesses that the later goal waits for the earlier one", async () => {
    const result = await plan({ project: "agentmux" }, fakeModel({ pair: { choice: "independent", probability: 0.2 } }));
    expect(result.items.find((item) => item.key === "t2")!.requires).toEqual(["t1"]);
  });

  it("the ordering judge sees each goal's proof as its criterion", async () => {
    const model = fakeModel();
    await plan({ project: "agentmux" }, model);
    const pair = model.of("## classification")[0]!;
    expect(pair).toContain("Goal A criterion: go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small");
    expect(pair).toContain("Goal B criterion: go_test: ./internal/capability name=TestRankedModelsKeepOrder size=small");
  });

  it("a single goal is not ordered", async () => {
    const model = fakeModel({ pieces: [TEXT] });
    const lone: ModelStep = async (prompt) =>
      prompt.startsWith("## Goals")
        ? JSON.stringify({ Goals: [{ outcome: G1, sources: [listedIds(prompt)[0]] }] })
        : model.step(prompt);
    const result = await plan({ project: "agentmux" }, { step: lone });
    expect(result.items).toHaveLength(1);
    expect(model.of("## classification")).toHaveLength(0);
  });

  it("a goal that restates an open task is marked duplicate_of, and the other item stays", async () => {
    const machine = machineOf({
      "atask --project proj-1 list open": ok(JSON.stringify({ ok: true, result: { tasks: [{ id: "at-abc123", title: SPEC_2.outcome }] } })),
    });
    const result = await plan({ project: "agentmux" }, fakeModel(), machine);
    expect(result.items.map((item) => [item.key, item.duplicate_of])).toEqual([["t1", undefined], ["t2", "at-abc123"]]);
  });

  it("refuses a proof that cannot fail and shows the model why on the retry", async () => {
    const model = fakeModel({ specs: { [G1]: [{ ...SPEC_1, proof: "run: echo fixed" }, SPEC_1] } });
    const result = await plan({ project: "agentmux" }, model);
    const prompts = model.objectiveFor(G1);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('proof command "echo fixed" cannot fail');
    expect(result.items[0]!.proof).toBe("go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small");
  });

  it("specifies goals at most SPEC_CONCURRENCY at once", () => {
    expect(SPEC_CONCURRENCY).toBe(4);
  });
});

describe("plan_tasks project", () => {
  it("chooses among the registered projects when none is named, showing home, README and top level", async () => {
    const model = fakeModel({ project: "agentmux" });
    const result = await plan({}, model);
    expect(result.project).toEqual({ id: "proj-1", name: "agentmux", needsNewProject: false });
    const prompt = model.of("## Project")[0]!;
    expect(prompt).toContain(`- "agentmux": home ${HOME}\n  README: Delegates work to coding agents.\n  Top level: README.md, go.mod, internal, mise.toml`);
    expect(prompt).toContain('- "general": no home known');
    expect(prompt).toContain('Options (reply with exactly one): "agentmux" | "general" | "new"');
    expect(prompt).toContain("Session directory (may not match the work): /work");
    expect(prompt).toContain(`<<<\n${TEXT}\n>>>`);
    // the chosen project's checkout grounds the checks
    expect(model.objectiveFor(G1)[0]).toContain(`Project home: ${HOME}`);
  });

  it("`new` plans without a checkout and reports needsNewProject", async () => {
    const result = await plan({}, fakeModel({ project: "new" }));
    expect(result.project).toEqual({ id: "", name: "", needsNewProject: true });
    expect(result.items).toHaveLength(2);
  });

  it("asks again, naming the menu, when the choice is not on it", async () => {
    let asks = 0;
    const model = fakeModel();
    const step: ModelStep = async (prompt) => {
      if (!prompt.startsWith("## Project")) return model.step(prompt);
      asks += 1;
      return JSON.stringify({ Project: asks === 1 ? "homelab" : "agentmux" });
    };
    const result = await plan({}, { step });
    expect(asks).toBe(2);
    expect(result.project.name).toBe("agentmux");
  });

  it("an empty registry is `new` without asking", async () => {
    const machine = new FakeMachine({ "atask projects": ok(JSON.stringify({ ok: true, result: [] })) });
    const model = fakeModel();
    const result = await plan({}, model, machine);
    expect(result.project.needsNewProject).toBe(true);
    expect(model.of("## Project")).toHaveLength(0);
  });

  it("a registered project without a home, and an unregistered name, are planned for with no checkout", async () => {
    for (const [named, expected] of [["general", { id: "proj-2", name: "general" }], ["scratch", { id: "", name: "scratch" }]] as const) {
      const model = fakeModel();
      const result = await plan({ project: named }, model);
      expect(result.project).toEqual({ ...expected, needsNewProject: false });
      expect(model.objectiveFor(G1)[0]).toContain("Project: unknown\nProject home: unknown");
    }
  });

  it("an absolute directory is the checkout itself, named by its last segment, with no registry read", async () => {
    const machine = machineOf();
    const result = await plan({ project: `${HOME}/` }, fakeModel(), machine);
    expect(result.project).toEqual({ id: "", name: "agentmux", needsNewProject: false });
    expect(machine.runs.some((run) => run.commandLine === "atask projects")).toBe(false);
  });

  it("parseChoice names the menu; chooserPrompt shows at most ENTRY_LIMIT top-level names", async () => {
    expect(() => parseChoice({ Project: "nope" }, ["a", "b"])).toThrow('Project "nope" is not on the menu: choose one of ["a" "b"] or "new"');
    expect(() => parseChoice("a", ["a"])).toThrow(/is not on the menu/);
    expect(parseChoice({ Project: "new" }, ["a"])).toBe("new");
    const files = Object.fromEntries(Array.from({ length: ENTRY_LIMIT + 5 }, (_, i) => [`/p/big/f${String(i).padStart(2, "0")}.txt`, "x"]));
    const machine = new FakeMachine({}, files);
    const prompt = await chooserPrompt("x", [{ id: "p", name: "big", home: "/p/big" }], "/w", machine);
    expect(prompt.match(/Top level: (.*)/)![1]!.split(", ")).toHaveLength(ENTRY_LIMIT);
  });
});

describe("plan_tasks failures", () => {
  it("refuses blank words before any model call", async () => {
    const model = fakeModel();
    await expect(plan({ text: "  \n" }, model)).rejects.toThrow("plan_tasks needs the words to plan");
    expect(model.prompts).toHaveLength(0);
  });

  it("a failed goal pass reads `identify the goals to plan: <cause>`", async () => {
    await expect(plan({ project: "agentmux" }, fakeModel({ goalsFail: new Error("model down") }))).rejects.toThrow(
      /^identify the goals to plan: identify the goals: model down/,
    );
  });

  it("a goal whose objective stays invalid fails as `write the task for <key>: <cause>`", async () => {
    const bad = { ...SPEC_1, proof: "run: echo fixed" };
    await expect(plan({ project: "agentmux" }, fakeModel({ specs: { [G1]: [bad] } }))).rejects.toThrow(
      /^write the task for t1: no valid reply after 3 attempts: fix the answer: /,
    );
  });

  it("an abort is not wrapped", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const step: ModelStep = async () => {
      throw new Error("killed");
    };
    await expect(plan({ project: "agentmux" }, { step }, machineOf(), { signal: controller.signal })).rejects.toThrow("stop");
  });

  it("reports its phases", async () => {
    const phases: string[] = [];
    await plan({ project: "agentmux" }, fakeModel(), machineOf(), { onPhase: (phase) => phases.push(phase) });
    expect(phases).toEqual(["choosing the project", "identifying the goals", "writing 2 tasks", "ordering the tasks"]);
  });
});

describe("plan_tasks apply", () => {
  /** Answers every `atask add` with the next id, and records its command line; everything else is the machine's own. */
  function filing(machine: FakeMachine, ids: string[]) {
    const adds: { line: string; env: Readonly<Record<string, string>> }[] = [];
    const real = machine.run.bind(machine);
    machine.run = async (command, args, env) => {
      if (command !== "atask" || args[0] !== "add") return real(command, args, env);
      adds.push({ line: [command, ...args].join(" "), env: env ?? {} });
      return addedTask(ids[adds.length - 1]!);
    };
    return adds;
  }

  it("is a dry run by default: no atask add is run", async () => {
    const machine = machineOf();
    const result = await plan({ project: "agentmux" }, fakeModel(), machine);
    expect(result.applied).toEqual([]);
    expect(machine.ataskAdds()).toEqual([]);
  });

  it("files each item with atask add in dependency order, each --requires holding the ids filed before it", async () => {
    const machine = machineOf();
    const adds = filing(machine, ["at-100", "at-101"]);
    const result = await plan({ project: "agentmux", apply: true }, fakeModel({ pair: { choice: "a_before_b" } }), machine);
    expect(result.applied).toEqual([{ key: "t1", id: "at-100" }, { key: "t2", id: "at-101" }]);
    expect(adds.map((add) => add.line)).toEqual([
      `atask add --project proj-1 ${SPEC_1.title} --outcome ${SPEC_1.outcome} --accept ${SPEC_1.acceptance[0]} --proof go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small --regression go_test: ./internal/capability size=medium`,
      `atask add --project proj-1 ${SPEC_2.title} --outcome ${SPEC_2.outcome} --accept ${SPEC_2.acceptance[0]} --proof go_test: ./internal/capability name=TestRankedModelsKeepOrder size=small --regression go_test: ./internal/capability size=medium --requires at-100`,
    ]);
    expect(adds.every((add) => add.env.ATASK_OUTPUT === "json")).toBe(true);
  });

  it("files in dependency order, not stated order, when the later goal comes first", async () => {
    const machine = machineOf();
    const adds = filing(machine, ["at-100", "at-101"]);
    const result = await plan({ project: "agentmux", apply: true }, fakeModel({ pair: { choice: "b_before_a" } }), machine);
    expect(result.applied).toEqual([{ key: "t2", id: "at-100" }, { key: "t1", id: "at-101" }]);
    expect(adds[0]!.line).toContain(SPEC_2.title);
    expect(adds[1]!.line).toEndWith("--requires at-100");
  });

  it("files nothing for a duplicate, and what waits for it waits for the open task", async () => {
    const machine = machineOf({
      "atask --project proj-1 list open": ok(JSON.stringify({ ok: true, result: { tasks: [{ id: "at-abc123", title: SPEC_1.outcome }] } })),
    });
    const adds = filing(machine, ["at-200"]);
    const result = await plan({ project: "agentmux", apply: true }, fakeModel({ pair: { choice: "a_before_b" } }), machine);
    expect(result.items.map((item) => [item.key, item.duplicate_of, item.requires])).toEqual([["t1", "at-abc123", []], ["t2", undefined, ["t1"]]]);
    expect(result.applied).toEqual([{ key: "t2", id: "at-200" }]);
    expect(adds).toHaveLength(1);
    expect(adds[0]!.line).toEndWith("--requires at-abc123");
  });

  it("a failing atask add stops the run and names what was already filed", async () => {
    let calls = 0;
    const machine = machineOf();
    const real = machine.run.bind(machine);
    machine.run = async (command, args, env) => {
      if (command === "atask" && args[0] === "add") {
        calls += 1;
        return calls === 1 ? addedTask("at-300") : { code: 1, stdout: "", stderr: "title too long" };
      }
      return real(command, args, env);
    };
    await expect(plan({ project: "agentmux", apply: true }, fakeModel(), machine)).rejects.toThrow(
      `\`atask add\` for t2 ${JSON.stringify(SPEC_2.title)} failed (exit 1): title too long; already filed: t1=at-300`,
    );
    expect(calls).toBe(2);
  });

  it("an atask add that prints something else is an error naming what was filed", async () => {
    const machine = machineOf();
    const real = machine.run.bind(machine);
    machine.run = async (command, args, env) => (command === "atask" && args[0] === "add" ? ok("not json") : real(command, args, env));
    await expect(plan({ project: "agentmux", apply: true }, fakeModel(), machine)).rejects.toThrow(
      /did not print the new task: .*; nothing filed yet/,
    );
  });

  it("refuses to apply when no project fits, before any model run beyond the chooser", async () => {
    const model = fakeModel({ project: "new" });
    await expect(plan({ apply: true }, model)).rejects.toThrow("no project fits this work: run `atask init` in the repo first, then plan again");
    expect(model.of("## Pieces")).toHaveLength(0);
  });

  it("builds atask add arguments: a draft is filed without its checks", () => {
    const item: PlannedItem = {
      key: "t1", title: "T", outcome: "O", acceptance: ["a", "b"], proof: "", regression: "", draft: true,
      requires: [], rationale: "r", goal: "g", sources: [],
    };
    expect(ataskAddArguments("p", item, ["at-1", "at-2"])).toEqual([
      "add", "--project", "p", "T", "--outcome", "O", "--accept", "a", "--accept", "b", "--requires", "at-1", "--requires", "at-2",
    ]);
    expect(ataskAddArguments("p", { ...item, draft: false, proof: "P", regression: "R" }, [])).toEqual([
      "add", "--project", "p", "T", "--outcome", "O", "--accept", "a", "--accept", "b", "--proof", "P", "--regression", "R",
    ]);
  });
});

describe("plan ordering", () => {
  const goal = (key: string): SpecifiedGoal => ({
    planned: { key, goal: { outcome: key, sources: [] }, part: undefined },
    objective: {
      title: key, outcome: key, acceptance: [], proof: "", regression: "", requires: [], rationale: "", draft: true,
      targeting: { runner: "none", changed_paths: [], test_files_considered: [], chosen_test: "", chosen_scope: "" },
      project: { id: "", name: "", needsNewProject: false }, applied: "",
    },
  });

  it("drops an edge that would close a cycle (the first judged edge wins) and ignores unknown keys", () => {
    const requires = prerequisites(["t1", "t2", "t3"], [
      { from: "t2", to: "t1" }, { from: "t3", to: "t2" }, { from: "t1", to: "t3" }, { from: "t1", to: "zz" }, { from: "t1", to: "t1" },
    ]);
    expect([...requires.get("t1")!]).toEqual([]);
    expect([...requires.get("t3")!]).toEqual(["t2"]);
  });

  it("orders items so each follows what it requires, otherwise in stated order", () => {
    const items = plannedItems([goal("t1"), goal("t2"), goal("t3")], [{ from: "t1", to: "t3" }, { from: "t3", to: "t2" }]);
    expect(items.map((item) => item.key)).toEqual(["t2", "t3", "t1"]);
    expect(items.map((item) => item.requires)).toEqual([[], ["t2"], ["t3"]]);
  });

  it("keys goals in the order their sources appear in the words, a whole-input goal last", () => {
    const part = (ID: string) => ({ ID }) as never;
    const planned = planGoals(
      [{ outcome: "whole", sources: ["prm"] }, { outcome: "second", sources: ["p2"] }, { outcome: "first", sources: ["p1"] }],
      [part("p1"), part("p2")],
    );
    expect(planned.map((entry) => [entry.key, entry.goal.outcome])).toEqual([["t1", "first"], ["t2", "second"], ["t3", "whole"]]);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/work", logger: {} } as never;
  }
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { project: unknown; items: { key: string }[]; applied: unknown[] } }>;
  };

  it("describes itself in 80 to 250 words, naming its siblings and the apply boundary", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    expect(tool.name).toBe("plan_tasks");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["define_objective", "identify_goals", "task"]) expect(tool.description).toContain(sibling);
    expect(tool.description).toContain("DRY RUN");
    expect(tool.description).toContain("ONLY when the user asked");
  });

  it("runs through execute: omp for the model, env/atask/git through pi.exec for the machine", async () => {
    const model = fakeModel();
    const machine = machineOf();
    const calls: string[] = [];
    const exec: Exec = async (command, args) => {
      calls.push(command);
      if (command === "omp") {
        return { stdout: await model.step(await readFile(args[1]!.slice(1), "utf8")), stderr: "", code: 0, killed: false };
      }
      const [program, rest] = command === "env" ? [args.find((arg) => !arg.includes("="))!, args.slice(args.findIndex((arg) => !arg.includes("=")) + 1)] : [command, args];
      const result = await machine.run(program, rest);
      return { ...result, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as Tool;
    const updates: string[] = [];
    const result = await tool.execute("t1", { text: TEXT, project: "agentmux", apply: null }, ((update: { content: { text: string }[] }) => updates.push(update.content[0]!.text)) as never, undefined);
    expect(result.details.items.map((item) => item.key)).toEqual(["t1", "t2"]);
    expect(result.details.applied).toEqual([]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect(updates).toContain("plan_tasks: identifying the goals");
    expect(machine.ataskAdds()).toEqual([]);
    expect(calls).toContain("env");
    await expect(tool.execute("t2", { text: " " }, undefined, undefined)).rejects.toThrow("plan_tasks needs the words to plan");
  });

  it("treats a dotted first segment as a host name, not a project path, unless it has a source extension", () => {
    const named = (check: string) => pathsNamedBy(check, "/home/u");
    expect(named("curl example.com/a")).toEqual([]);
    expect(named("curl api.example-1.org/v1")).toEqual([]);
    expect(named("cat src/a.ts")).toEqual(["src/a.ts"]);
    expect(named("cat a..b/c")).toEqual([]);
    expect(named("cat -x.y/c")).toEqual([]);
    expect(named("cat v1.0/c")).toEqual([]);
    expect(named("cat my_dir.x/c")).toEqual(["my_dir.x/c"]);
  });
});
