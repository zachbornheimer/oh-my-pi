import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { assembleDag, DependencyGraphError, reduceSemanticEdges, validateGraph } from "./assemble.js";
import { ATOMICITY_CLASSIFICATION, judgeAtomicity, shapeAtomicity, shippedAtomicity } from "./atomicity.js";
import { MAX_CONCURRENT_PAIRS, runCreateDag } from "./create_dag.js";
import factory from "./index.js";
import { applyPair, edgePrompt, parseEdge, sharesDeclaredResource, UNKNOWN_EDGE, verdictFor } from "./judge.js";
import { mergeDuplicateNodes, overlappingStatements } from "./merge.js";
import { NO_WORK_MESSAGE, observeWork } from "./observe.js";
import { type Exec, type ModelStep } from "./omp_model.js";
import { parseRequest, readRequest } from "./request.js";
import { inferredResources, normalizeStatement, stableNodeId } from "./text.js";
import type { DagNode } from "./types.js";

type Verdict = "yes" | "no" | "unknown";
const prob = (verdict: Verdict): number => (verdict === "yes" ? 0.9 : verdict === "no" ? 0.1 : 0.5);

interface Scripted {
  a: string;
  b: string;
  order: string;
  b_needs_a_output?: Verdict;
  same_resource?: Verdict;
}

const statementsOf = (prompt: string) => ({
  a: JSON.parse(/^Goal A: (.*)$/m.exec(prompt)![1]!) as string,
  b: JSON.parse(/^Goal B: (.*)$/m.exec(prompt)![1]!) as string,
});

/**
 * agentmux's scriptedEdgeModel: a listed pair answers as scripted (either order of the two statements), any other
 * pair answers parallel, no output needed, no shared resource. Atomicity prompts answer `atomicity`.
 */
function fakeModel(edges: Scripted[] = [], atomicity: { choice: string; probability: number } | Error = new Error("no atomicity scripted")) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("## classification")) {
      if (atomicity instanceof Error) throw atomicity;
      return JSON.stringify({ classification: atomicity.choice, probability: atomicity.probability });
    }
    const { a, b } = statementsOf(prompt);
    const hit = edges.find((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a));
    // a scripted pair is written from its own point of view: swap the order when the prompt asks the other way round.
    const flipped = hit !== undefined && hit.a !== a;
    const flip = (order: string) => (!flipped ? order : order === "a_before_b" ? "b_before_a" : order === "b_before_a" ? "a_before_b" : order);
    return JSON.stringify({
      order: hit === undefined ? "parallel" : flip(hit.order),
      b_needs_a_output: prob(hit?.b_needs_a_output ?? "no"),
      same_resource: prob(hit?.same_resource ?? "no"),
    });
  };
  return {
    step,
    prompts,
    edgePrompts: () => prompts.filter((prompt) => prompt.startsWith("## order")),
    atomicityPrompts: () => prompts.filter((prompt) => prompt.startsWith("## classification")),
  };
}

const unit = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({ id, statement, ...extra });
const run = (request: unknown, model: { step: ModelStep }) => runCreateDag(request, { step: model.step });
const yes = { b_needs_a_output: "yes", same_resource: "no" } as const;

describe("create_dag (Mastra parity cases U2-U15, C1, C2)", () => {
  it("U2: bullets decompose and exact duplicates merge", async () => {
    const result = await run({ text: "- write the schema\n- write the schema\n- backfill the table" }, fakeModel());
    expect(result.Nodes).toHaveLength(2);
    expect(result.Nodes.every((node) => node.Provenance.Source === "decomposed")).toBe(true);
  });

  it("U3: merging is case-insensitive", async () => {
    const result = await run({ text: "- write the schema\n- Write the Schema\n- backfill the table" }, fakeModel());
    expect(result.Nodes).toHaveLength(2);
  });

  it("U4: independent parallel goals have no edge and both are ready", async () => {
    const result = await run({ units: [unit("a", "write the README"), unit("b", "add a changelog")] }, fakeModel());
    expect(result.SemanticEdges).toEqual([]);
    expect(result.Ready).toEqual(["a", "b"]);
  });

  it("U5: a true dependency is producer to consumer, with evidence", async () => {
    const model = fakeModel([{ a: "write the schema", b: "backfill the table", order: "a_before_b", ...yes }]);
    const result = await run({ units: [unit("a", "write the schema"), unit("b", "backfill the table")] }, model);
    expect(result.SemanticEdges).toEqual([{ From: "a", To: "b", Evidence: "b_needs_a_output" }]);
    expect(result.Ready).toEqual(["a"]);
    expect(result.Graph.Nodes).toEqual([{ ID: "a", DependsOn: [], Done: false }, { ID: "b", DependsOn: ["a"], Done: false }]);
  });

  it("U6: a conflict is a mutex, not an edge", async () => {
    // Mastra's case names main.go in both statements, which is a mutex without asking (U14); here the model says conflict.
    const model = fakeModel([{ a: "edit the entry file", b: "rewrite the entry file", order: "conflict", b_needs_a_output: "unknown", same_resource: "unknown" }]);
    const result = await run({ units: [unit("a", "edit the entry file"), unit("b", "rewrite the entry file")] }, model);
    expect(result.SemanticEdges).toEqual([]);
    expect(result.Mutexes).toEqual([{ A: "a", B: "b" }]);
    expect(model.edgePrompts()).toHaveLength(1);
  });

  it("U7: a yes on same_resource is a mutex even when the order says parallel", async () => {
    const model = fakeModel([{ a: "tidy up one", b: "tidy up two", order: "parallel", b_needs_a_output: "no", same_resource: "yes" }]);
    const result = await run({ units: [unit("a", "tidy up one"), unit("b", "tidy up two")] }, model);
    expect(result.SemanticEdges).toEqual([]);
    expect(result.Mutexes).toEqual([{ A: "a", B: "b" }]);
  });

  it("U8: an unknown order is an open uncertainty", async () => {
    const model = fakeModel([{ a: "maybe first", b: "maybe second", order: "parallel" }]);
    const unknown: ModelStep = async (prompt) => (prompt.startsWith("## order") ? "not json" : model.step(prompt));
    const result = await run({ units: [unit("a", "maybe first"), unit("b", "maybe second")] }, { step: unknown });
    expect(result.SemanticEdges).toEqual([]);
    expect(result.OpenUncertainty).toEqual([{ A: "a", B: "b", Reason: "unknown order" }]);
  });

  it("U9: a dependency cycle fails the run with the taskgraph message and nothing is re-asked", async () => {
    const model = fakeModel([
      { a: "step a", b: "step b", order: "a_before_b", ...yes },
      { a: "step b", b: "step c", order: "a_before_b", ...yes },
      { a: "step a", b: "step c", order: "b_before_a", b_needs_a_output: "unknown", same_resource: "no" },
    ]);
    await expect(run({ units: [unit("a", "step a"), unit("b", "step b"), unit("c", "step c")] }, model)).rejects.toThrow(
      "create_dag: classify task graph: validate task graph: taskgraph: dependency cycle",
    );
    expect(model.edgePrompts()).toHaveLength(3);
  });

  it("U10: edges are transitively reduced", async () => {
    const model = fakeModel([
      { a: "step a", b: "step b", order: "a_before_b", ...yes },
      { a: "step b", b: "step c", order: "a_before_b", ...yes },
      { a: "step a", b: "step c", order: "a_before_b", ...yes },
    ]);
    const result = await run({ units: [unit("a", "step a"), unit("b", "step b"), unit("c", "step c")] }, model);
    expect(result.SemanticEdges).toEqual([
      { From: "a", To: "b", Evidence: "b_needs_a_output" },
      { From: "b", To: "c", Evidence: "b_needs_a_output" },
    ]);
    expect(result.Ready).toEqual(["a"]);
  });

  it("U11: declared shared resources are mutexes without asking, case-insensitively", async () => {
    const model = fakeModel();
    const result = await run(
      { units: [unit("a", "format code", { resources: ["Main.go"] }), unit("b", "lint code", { resources: ["main.go"] })] },
      model,
    );
    expect(result.Mutexes).toEqual([{ A: "a", B: "b" }]);
    expect(result.SemanticEdges).toEqual([]);
    expect(model.edgePrompts()).toHaveLength(0);
  });

  it("U12: punctuation variants merge; the smaller id, longer statement and the union of lists survive", async () => {
    const result = await run(
      {
        units: [
          unit("z", "write the schema.", { obligations: ["keep migrations"] }),
          unit("a", "write the schema", { constraints: ["no downtime"], tools: ["psql"] }),
          unit("b", "backfill the table"),
        ],
      },
      fakeModel(),
    );
    expect(result.Nodes).toHaveLength(2);
    expect(result.Nodes.find((node) => node.ID === "a")).toMatchObject({
      Statement: "write the schema.",
      Obligations: ["keep migrations"],
      Constraints: ["no downtime"],
      Tools: ["psql"],
    });
  });

  it("U13: a statement that starts a longer one (3+ words) merges into it", async () => {
    const result = await run(
      {
        units: [
          unit("z", "write the schema", { obligations: ["keep migrations"], resources: ["schema.sql"] }),
          unit("a", "write the schema for the table", { constraints: ["no downtime"], tools: ["psql"] }),
          unit("b", "backfill the table"),
        ],
      },
      fakeModel(),
    );
    expect(result.Nodes).toHaveLength(2);
    expect(result.Nodes.find((node) => node.ID === "a")).toMatchObject({
      Statement: "write the schema for the table",
      Obligations: ["keep migrations"],
      Constraints: ["no downtime"],
      Resources: ["schema.sql"],
      Tools: ["psql"],
    });
  });

  it("U14: a file named in both statements is a shared resource, a mutex without asking", async () => {
    const model = fakeModel();
    const result = await run({ units: [unit("a", "format main.go"), unit("b", "lint main.go")] }, model);
    expect(result.Mutexes).toEqual([{ A: "a", B: "b" }]);
    expect(result.SemanticEdges).toEqual([]);
    expect(model.edgePrompts()).toHaveLength(0);
    expect(result.ResourceRequirements).toEqual([{ Node: "a", Resources: ["main.go"] }, { Node: "b", Resources: ["main.go"] }]);
  });

  it("U15: a_before_b without B needing A's output is input order, not an edge", async () => {
    const model = fakeModel([{ a: "write the README", b: "add a changelog", order: "a_before_b", b_needs_a_output: "no" }]);
    const result = await run({ units: [unit("a", "write the README"), unit("b", "add a changelog")] }, model);
    expect(result.SemanticEdges).toEqual([]);
    expect(result.Ready).toEqual(["a", "b"]);
  });

  it("C1: an atomic text stays one node with no model call at all", async () => {
    const model = fakeModel();
    const result = await run({ text: "Add a dark mode toggle to the settings page." }, model);
    expect(result.Nodes).toHaveLength(1);
    expect(result.Nodes[0]!.Provenance).toEqual({ ParentID: "", Source: "input" });
    expect(model.prompts).toHaveLength(0);
  });

  it("C2: input order is not an edge", async () => {
    const result = await run({ units: [unit("b", "add a changelog"), unit("a", "write the README")] }, fakeModel());
    expect(result.SemanticEdges).toEqual([]);
    expect(result.Ready).toEqual(["a", "b"]);
  });
});

describe("create_dag atomicity (Mastra judge tables)", () => {
  const without: [string, string, string][] = [
    ["shipped compound example", "Rewrite the API layer migrate the database redesign the dashboard", "compound"],
    ["shipped three clause example", "Rename the field `userId` to `accountId` across the API, the DB schema, and the client SDK, keeping behavior identical.", "atomic"],
    ["shipped bullets example", "- Run go test ./...\n- Output must be green\n(acceptance criteria for: Fix flaky TestFoo)", "atomic"],
    ["single line", "Add a dark mode toggle to the settings page.", "atomic"],
    ["and also", "Fix the login bug and also refactor the auth module.", "compound"],
    ["bullets", "- Run go test ./...\n- Output must be green", "compound"],
  ];
  for (const [name, text, want] of without) {
    it(`decides "${name}" without the model`, async () => {
      const model = fakeModel();
      expect(await judgeAtomicity(text, model.step)).toBe(want as "atomic");
      expect(model.prompts).toHaveLength(0);
    });
  }

  it("asks the model once for a multi-line text that neither examples nor shape decide", async () => {
    const text = "Fix the flaky test.\nThen confirm CI is green.";
    for (const [choice, probability, want] of [["atomic", 0.9, "atomic"], ["compound", 0.9, "compound"], ["atomic", 0.69, "compound"]] as const) {
      const model = fakeModel([], { choice, probability });
      expect(await judgeAtomicity(text, model.step)).toBe(want);
      expect(model.atomicityPrompts()).toHaveLength(1);
      expect(model.atomicityPrompts()[0]).toContain(`<<<\n${text}\n>>>`);
    }
  });

  it("a blank statement, a failing model and an unreadable reply are compound; an abort is thrown", async () => {
    expect(await judgeAtomicity("  ", fakeModel().step)).toBe("compound");
    expect(await judgeAtomicity("a\nb", fakeModel().step)).toBe("compound");
    expect(await judgeAtomicity("a\nb", async () => "garbage")).toBe("compound");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(judgeAtomicity("a\nb", async () => { throw new Error("killed"); }, controller.signal)).rejects.toThrow("stop");
  });

  it("keeps check_atomicity's threshold and seven examples; shape rules count bullets, 'and also' and commas", () => {
    expect(ATOMICITY_CLASSIFICATION.threshold).toBe(0.7);
    expect(ATOMICITY_CLASSIFICATION.examples).toHaveLength(7);
    expect(shippedAtomicity("Add a dark mode toggle to the settings page.")).toBe("atomic");
    expect(shapeAtomicity("a, b, c")).toBe("compound");
    expect(shapeAtomicity("a, b")).toBe("atomic");
    expect(shapeAtomicity("one\ntwo")).toBeUndefined();
  });
});

describe("create_dag defects fixed against the Mastra port", () => {
  it("an empty call is refused, as its code always did (the description used to say it was a graph of nothing)", async () => {
    await expect(run({}, fakeModel())).rejects.toThrow(NO_WORK_MESSAGE);
    await expect(run({ text: "  ", units: [] }, fakeModel())).rejects.toThrow(NO_WORK_MESSAGE);
  });

  it("a unit with no statement and no obligations is refused instead of becoming an empty node", async () => {
    await expect(run({ units: [unit("a", "  "), unit("b", "x")] }, fakeModel())).rejects.toThrow(
      'create_dag: unit 0 ("a") has no statement or obligations',
    );
  });

  it("a unit with only obligations uses them as its statement", async () => {
    const result = await run({ units: [{ id: "a", obligations: ["ship the schema"] }] }, fakeModel());
    expect(result.Nodes[0]!.Statement).toBe("ship the schema");
  });

  it("obligations with edge whitespace on a bulleted unit do not fail a coverage check that no writer can fail", async () => {
    const result = await run({ units: [unit("p", "- one thing\n- another thing", { obligations: ["  keep it  "] })] }, fakeModel());
    expect(result.Nodes.map((node) => node.Obligations)).toEqual([["  keep it  "], ["  keep it  "]]);
  });

  it("never asks a safe_concurrent question, which no rule read", () => {
    const a = { ID: "a", Statement: "x" } as DagNode;
    const b = { ID: "b", Statement: "y" } as DagNode;
    expect(edgePrompt(a, b)).not.toContain("safe_concurrent");
    expect(edgePrompt(a, b)).toContain('Goal A: "x"');
  });
});

describe("create_dag pieces", () => {
  const node = (id: string, statement: string, extra: Partial<DagNode> = {}): DagNode => ({
    ID: id, Statement: statement, Obligations: [], Constraints: [], Resources: [], Tools: [], Provenance: { ParentID: "", Source: "input" }, ...extra,
  });

  it("reads a JSON request out of text and leaves other text alone", () => {
    const parsed = (value: unknown) => parseRequest(readRequest(value));
    expect(parsed({ text: '{"units":[{"id":"a","statement":"write the schema"}]}' }).units).toHaveLength(1);
    expect(parsed({ text: '{"text":"write the schema"}' }).text).toBe("write the schema");
    expect(parsed({ text: "{not json" }).text).toBe("{not json");
    expect(parsed({ text: "write the schema" }).units).toEqual([]);
    expect(parsed({ units: [{ statement: "x" }], text: '{"units":[{"statement":"y"}]}' }).units[0]!.statement).toBe("x");
  });

  it("reads null and omitted fields as empty and names a wrong type", () => {
    expect(readRequest({ units: null, text: null })).toEqual({ units: [], text: "" });
    expect(readRequest({ units: [{ id: null, resources: null }] }).units[0]).toEqual({ id: "", statement: "", obligations: [], constraints: [], resources: [], tools: [] });
    expect(() => readRequest({ units: "x" })).toThrow("units must be a list");
    expect(() => readRequest({ units: [{ tools: [1] }] })).toThrow("units[0].tools must be a list of strings");
    expect(() => readRequest(null)).toThrow(/must be an object/);
  });

  it("normalizes statements, infers file resources and gives stable ids", () => {
    expect(normalizeStatement("  Write the Schema. ")).toBe("write the schema");
    expect(inferredResources("format main.go and (lint src/util.TS), then README")).toEqual(["main.go", "src/util.TS"]);
    expect(stableNodeId("  a ", "x")).toBe("a");
    expect(stableNodeId("", "Write the README.")).toBe(stableNodeId("", "write the readme"));
    expect(stableNodeId("", "write the README")).toMatch(/^n_[0-9a-f]{16}$/);
  });

  it("merge: same key merges, prefix overlap needs 3+ words on both sides and different lengths", () => {
    expect(overlappingStatements("write the schema", "write the schema for it")).toBe(true);
    expect(overlappingStatements("write the", "write the schema now")).toBe(false);
    expect(overlappingStatements("write the schema", "write the schema.")).toBe(false);
    expect(mergeDuplicateNodes([node("b", "Do It."), node("a", "do it")]).map((n) => n.ID)).toEqual(["a"]);
  });

  it("verdicts are yes at 0.7 and above, no at 0.3 and below, else unknown", () => {
    expect([0.7, 1, 0.69, 0.5, 0.31, 0.3, 0].map(verdictFor)).toEqual(["yes", "yes", "unknown", "unknown", "unknown", "no", "no"]);
  });

  it("parseEdge names the problem so the model can be asked again", () => {
    expect(() => parseEdge({ order: "sideways", b_needs_a_output: 0.5, same_resource: 0.5 })).toThrow(/order must be one of a_before_b, b_before_a, parallel, conflict/);
    expect(() => parseEdge({ order: "parallel", b_needs_a_output: "yes", same_resource: 0.5 })).toThrow(/b_needs_a_output must be a number from 0 to 1/);
    expect(parseEdge({ order: " conflict ", b_needs_a_output: 0.5, same_resource: 0.2 })).toEqual({ order: "conflict", bNeedsAOutput: "unknown", sameResource: "no" });
  });

  it("applyPair: b_before_a is an edge even without consumption; unknown is an uncertainty", () => {
    const a = node("a", "x");
    const b = node("b", "y");
    expect(applyPair(a, b, { order: "b_before_a", bNeedsAOutput: "no", sameResource: "no" })).toEqual({ edge: { From: "b", To: "a", Evidence: "b_before_a" } });
    expect(applyPair(a, b, UNKNOWN_EDGE)).toEqual({ uncertainty: { A: "a", B: "b", Reason: "unknown order" } });
    expect(sharesDeclaredResource(node("a", "x", { Resources: ["Db"] }), node("b", "y", { Resources: [" db "] }))).toBe(true);
  });

  it("assemble: reduces edges, rejects cycles and repeated ids", () => {
    const edges = [{ From: "a", To: "b", Evidence: "e" }, { From: "b", To: "c", Evidence: "e" }, { From: "a", To: "c", Evidence: "e" }];
    expect(reduceSemanticEdges(edges)).toHaveLength(2);
    expect(() => validateGraph([{ ID: "a", DependsOn: ["b"], Done: false }, { ID: "b", DependsOn: ["a"], Done: false }])).toThrow(DependencyGraphError);
    expect(() => validateGraph([{ ID: "a", DependsOn: [], Done: false }, { ID: "a", DependsOn: [], Done: false }])).toThrow(/duplicate node id: "a"/);
    const graph = assembleDag([node("a", "x"), node("b", "y")], { edges: [], mutexes: [], uncertainty: [] });
    expect(graph.Ready).toEqual(["a", "b"]);
  });

  it("judges pairs at most MAX_CONCURRENT_PAIRS at once and asks each pair once, in node order", async () => {
    let active = 0;
    let peak = 0;
    const gate = Promise.withResolvers<void>();
    const asked: string[] = [];
    const step: ModelStep = async (prompt) => {
      const { a, b } = statementsOf(prompt);
      asked.push(`${a}|${b}`);
      active += 1;
      peak = Math.max(peak, active);
      if (active >= MAX_CONCURRENT_PAIRS) gate.resolve();
      await gate.promise;
      active -= 1;
      return JSON.stringify({ order: "parallel", b_needs_a_output: 0.1, same_resource: 0.1 });
    };
    const units = ["one", "two", "three", "four", "five", "six"].map((name) => unit(name, `do ${name}`));
    const result = await runCreateDag({ units }, { step });
    expect(result.Nodes).toHaveLength(6);
    expect(asked).toHaveLength(15);
    expect(new Set(asked).size).toBe(15);
    expect(peak).toBe(MAX_CONCURRENT_PAIRS);
  });

  it("an abort stops the run rather than turning every pair into an uncertainty", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort(new Error("stop"));
      throw new Error("killed");
    };
    await expect(runCreateDag({ units: [unit("a", "do a"), unit("b", "do b")] }, { step, signal: controller.signal })).rejects.toThrow("stop");
  });

  it("reports its phases", async () => {
    const phases: string[] = [];
    await runCreateDag({ units: [unit("a", "do a"), unit("b", "do b")] }, { step: fakeModel().step, onPhase: (phase) => phases.push(phase) });
    expect(phases).toEqual(["judging units", "judging 1 pairs of 2 nodes"]);
  });

  it("observeWork judges each unit with its index", async () => {
    const seen: [string, number][] = [];
    await observeWork([unit("a", "x"), unit("b", "y")].map((u) => ({ obligations: [], constraints: [], resources: [], tools: [], ...u })), "", async (statement, index) => {
      seen.push([statement, index]);
      return "atomic";
    });
    expect(seen).toEqual([["x", 0], ["y", 1]]);
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
    execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { Ready: string[]; SemanticEdges: unknown[] } }>;
  };

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    expect(tool.name).toBe("create_dag");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["identify_goals", "plan_infer_dependency", "plan_tasks"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp and returns the graph in details", async () => {
    const model = fakeModel([{ a: "write the schema", b: "backfill the table", order: "a_before_b", ...yes }]);
    const exec: Exec = async (command, args) => {
      if (command !== "omp") throw new Error(`unexpected ${command}`);
      return { stdout: await model.step(await readFile(args[1]!.slice(1), "utf8")), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as Tool;
    const updates: string[] = [];
    const result = await tool.execute(
      "t1",
      { units: [{ id: "a", statement: "write the schema", tools: null }, { id: "b", statement: "backfill the table" }], text: null },
      ((update: { content: { text: string }[] }) => updates.push(update.content[0]!.text)) as never,
      undefined,
    );
    expect(result.details.SemanticEdges).toEqual([{ From: "a", To: "b", Evidence: "b_needs_a_output" }]);
    expect(result.details.Ready).toEqual(["a"]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect(updates).toContain("create_dag: judging units");
    await expect(tool.execute("t2", {}, undefined, undefined)).rejects.toThrow(NO_WORK_MESSAGE);
  });
});
