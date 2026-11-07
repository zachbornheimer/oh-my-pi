import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import factory from "./index.js";
import { type Exec, type ModelStep } from "./omp_model.js";
import { MAX_CONCURRENT_PAIRS, runInferDependency } from "./plan_infer_dependency.js";
import { edgeFor, PAIR_CLASSIFICATION, pairsOf, pairText } from "./pairs.js";

const reply = (choice: string, probability = 0.95): string => JSON.stringify({ classification: choice, probability });

/** The two goal statements and ids of the pair a prompt asks about (the quoted text, not the worked examples). */
function pairOf(prompt: string) {
  const quoted = prompt.slice(prompt.lastIndexOf("<<<\n") + 4, prompt.lastIndexOf("\n>>>"));
  const line = (label: string) => new RegExp(`^Goal ${label}: (.*)$`, "m").exec(quoted)![1]!;
  const id = (label: string) => new RegExp(`^Goal ${label} id: (.*)$`, "m").exec(quoted)![1]!;
  return { a: line("A"), b: line("B"), aId: id("A"), bId: id("B"), quoted };
}

/** agentmux's mustPrecede classifier: a listed pair answers a_before_b / b_before_a by which side each lands on, anything else independent. */
function precede(pairs: [string, string][], options: { fail?: [string, string]; answerAll?: string } = {}) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const { a, b } = pairOf(prompt);
    if (options.fail && [a, b].sort().join("|") === [...options.fail].sort().join("|")) throw new Error("model down");
    if (options.answerAll !== undefined) return reply(options.answerAll);
    for (const [before, after] of pairs) {
      if (a === before && b === after) return reply("a_before_b");
      if (b === before && a === after) return reply("b_before_a");
    }
    return reply("independent");
  };
  return { step, prompts };
}

const goal = (id: string, statement: string, criteria?: string[]) => ({ id, statement, ...(criteria ? { criteria } : {}) });

describe("plan_infer_dependency (Mastra parity cases T1-T10, S1)", () => {
  it("T1: the migration yields exactly one edge in one call", async () => {
    const model = precede([["write the migration", "run the migration against staging"]]);
    const result = await runInferDependency(
      [goal("w", "write the migration"), goal("r", "run the migration against staging")],
      { step: model.step },
    );
    expect(result).toEqual({ edges: [{ from: "r", to: "w" }], guessed: [], certainty: 1 });
    expect(model.prompts).toHaveLength(1);
  });

  it("T2: the direction holds when the input order is reversed", async () => {
    const model = precede([["write the migration", "run the migration against staging"]]);
    const result = await runInferDependency(
      [goal("r", "run the migration against staging"), goal("w", "write the migration")],
      { step: model.step },
    );
    expect(result.edges).toEqual([{ from: "r", to: "w" }]);
    expect(model.prompts).toHaveLength(1);
  });

  it("T3: independent goals get no edges, one call per pair", async () => {
    const model = precede([]);
    const result = await runInferDependency(
      [goal("1", "buy flour"), goal("2", "buy eggs"), goal("3", "add a README badge")],
      { step: model.step },
    );
    expect(result).toEqual({ edges: [], guessed: [], certainty: 1 });
    expect(model.prompts).toHaveLength(3);
  });

  it("T4: a shared renamed field orders the endpoint and the docs after the rename", async () => {
    const rename = "rename field user_id to account_id in schema.go";
    const model = precede([
      [rename, "add endpoint returning account_id"],
      [rename, "update docs for the API"],
    ]);
    const result = await runInferDependency(
      [goal("rn", rename), goal("ep", "add endpoint returning account_id"), goal("dc", "update docs for the API")],
      { step: model.step },
    );
    expect(result.edges).toEqual([{ from: "ep", to: "rn" }, { from: "dc", to: "rn" }]);
    expect(model.prompts).toHaveLength(3);
    expect(result.certainty).toBe(1);
  });

  it("T5: a failed pair keeps the other edges and resolves to depends, listed as guessed", async () => {
    const model = precede([["a", "b"]], { fail: ["a", "c"] });
    const result = await runInferDependency([goal("A", "a"), goal("B", "b"), goal("C", "c")], { step: model.step });
    expect(result.edges).toEqual([{ from: "B", to: "A" }, { from: "C", to: "A" }]);
    expect(result.guessed).toEqual([{ from: "C", to: "A" }]);
    expect(result.certainty).toBe(0);
  });

  it("T6: a model saying depends both ways never makes a two-cycle (one pair, one edge)", async () => {
    const result = await runInferDependency([goal("A", "a"), goal("B", "b")], { step: precede([], { answerAll: "a_before_b" }).step });
    expect(result.edges).toHaveLength(1);
  });

  it("T7: same-title goals stay distinct by id", async () => {
    const result = await runInferDependency([goal("g1", "fix tests"), goal("g2", "fix tests")], {
      step: precede([], { answerAll: "b_before_a" }).step,
    });
    expect(result.edges).toEqual([{ from: "g1", to: "g2" }]);
  });

  it("T8: the judge sees the criteria and ids, as labelled lines", async () => {
    const model = precede([]);
    await runInferDependency([goal("g1", "fix tests", ["go test ./... passes"]), goal("g2", "x || y")], { step: model.step });
    expect(pairOf(model.prompts[0]!).quoted).toBe(
      "Goal A: fix tests\nGoal A id: g1\nGoal A criterion: go test ./... passes\n\nGoal B: x || y\nGoal B id: g2\n",
    );
  });

  it("T9: empty (or blank), and duplicate, ids are refused before any model call", async () => {
    const model = precede([]);
    await expect(runInferDependency([goal("", "a"), goal("b", "b")], { step: model.step })).rejects.toThrow(
      'infer dependency: goal 0 ("a") has no id',
    );
    await expect(runInferDependency([goal("   ", "a"), goal("b", "b")], { step: model.step })).rejects.toThrow(
      'infer dependency: goal 0 ("a") has no id',
    );
    await expect(runInferDependency([goal("x", "a"), goal("x", "b")], { step: model.step })).rejects.toThrow(
      'infer dependency: duplicate goal id "x"',
    );
    expect(model.prompts).toHaveLength(0);
  });

  it("T10: a cancelled run is an error, not an all-guessed answer", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort(new Error("stop"));
      throw new Error("killed");
    };
    await expect(runInferDependency([goal("a", "a"), goal("b", "b")], { step, signal: controller.signal })).rejects.toThrow(
      "infer dependency: run cancelled",
    );
  });

  it("S1: the 0.6 threshold is inclusive; below it, or an unreadable reply, is the unsure fallback", async () => {
    const goals = [goal("A", "a"), goal("B", "b")];
    const run = (text: string) => runInferDependency(goals, { step: async () => text });
    const down = { edges: [{ from: "B", to: "A" }], guessed: [{ from: "B", to: "A" }], certainty: 0 };
    expect(await run(reply("a_before_b", 0.9))).toEqual({ edges: [{ from: "B", to: "A" }], guessed: [], certainty: 1 });
    expect(await run(reply("b_before_a", 0.6))).toEqual({ edges: [{ from: "A", to: "B" }], guessed: [], certainty: 1 });
    expect(await run(reply("independent", 0.99))).toEqual({ edges: [], guessed: [], certainty: 1 });
    expect(await run(reply("independent", 0.59))).toEqual(down);
    expect(await run(reply("b_before_a", 0.59))).toEqual(down);
    expect(await run(reply("not_a_category", 0.99))).toEqual(down);
  });
});

describe("plan_infer_dependency details", () => {
  it("pairs run at most MAX_CONCURRENT_PAIRS at once and results keep pair order", async () => {
    let active = 0;
    let peak = 0;
    // The first MAX_CONCURRENT_PAIRS calls wait on the gate, which opens once that many are in flight.
    const gate = Promise.withResolvers<void>();
    const step: ModelStep = async (prompt) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active >= MAX_CONCURRENT_PAIRS) gate.resolve();
      await gate.promise;
      active -= 1;
      const { a, b } = pairOf(prompt);
      return reply(a < b ? "a_before_b" : "b_before_a");
    };
    const goals = ["a", "b", "c", "d", "e", "f"].map((name) => goal(name, name));
    const result = await runInferDependency(goals, { step });
    expect(pairsOf(6)).toHaveLength(15);
    expect(peak).toBe(MAX_CONCURRENT_PAIRS);
    expect(result.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(
      pairsOf(6).map(({ earlier, later }) => `${goals[later]!.id}>${goals[earlier]!.id}`),
    );
  });

  it("an empty list has no pairs and no calls", async () => {
    const model = precede([]);
    expect(await runInferDependency([], { step: model.step })).toEqual({ edges: [], guessed: [], certainty: 1 });
    expect(await runInferDependency([goal("a", "a")], { step: model.step })).toEqual({ edges: [], guessed: [], certainty: 1 });
    expect(model.prompts).toHaveLength(0);
  });

  it("reports progress per pair", async () => {
    const seen: string[] = [];
    await runInferDependency([goal("a", "a"), goal("b", "b"), goal("c", "c")], {
      step: precede([]).step,
      onPair: (done, total) => seen.push(`${done}/${total}`),
    });
    expect(seen).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("asks the pair question with the menu and quotes the pair", () => {
    expect(edgeFor("earlier_first", "e", "l")).toEqual({ from: "l", to: "e" });
    expect(edgeFor("later_first", "e", "l")).toEqual({ from: "e", to: "l" });
    expect(edgeFor("unordered", "e", "l")).toBeUndefined();
    expect(PAIR_CLASSIFICATION.categories.map((category) => category.id)).toEqual(["a_before_b", "b_before_a", "independent"]);
    expect(pairText(goal("x", "s"), goal("y", "t"))).toBe("Goal A: s\nGoal A id: x\n\nGoal B: t\nGoal B id: y\n");
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
  };

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    expect(tool.name).toBe("plan_infer_dependency");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["identify_goals", "create_dag"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp; null fields read as empty", async () => {
    const exec: Exec = async (command, args) => {
      if (command !== "omp") throw new Error(`unexpected ${command}`);
      const prompt = await readFile(args[1]!.slice(1), "utf8");
      expect(pairOf(prompt).a).toBe("write it");
      return { stdout: reply("a_before_b"), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as Tool;
    const result = await tool.execute(
      "t1",
      { goals: [{ id: "w", statement: "write it", criteria: null }, { id: "r", statement: "run it" }] },
      undefined,
      undefined,
    );
    expect(result.details).toEqual({ edges: [{ from: "r", to: "w" }], guessed: [], certainty: 1 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect((await tool.execute("t2", { goals: null }, undefined, undefined)).details).toEqual({ edges: [], guessed: [], certainty: 1 });
    await expect(tool.execute("t3", { goals: [{ id: null, statement: "a" }] }, undefined, undefined)).rejects.toThrow(/has no id/);
  });
});
