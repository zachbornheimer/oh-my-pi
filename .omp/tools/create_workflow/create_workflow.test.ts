import { describe, expect, it } from "bun:test";
import { type CreateWorkflowDeps, type CreateWorkflowInput, runCreateWorkflow } from "./create_workflow.js";
import factory, { DESCRIPTION } from "./index.js";
import { designOf, leavesToBuild, plan } from "./leaves.js";
import type { DirEntry, Machine } from "./machine.js";
import type { ModelStep } from "./omp_model.js";
import { isCapabilityName, type Leaf, type ProposedCapability, type Source, type SourceRun } from "./types.js";

describe("isCapabilityName", () => {
  it("accepts dotted snake_case segments and rejects everything the nested-group pattern rejected", () => {
    const accepted = ["a", "webmaster.page.seo", "a_b.c1", "a.b.c.d", "a.b_"];
    const rejected = ["", ".", "a.", ".a", "a..b", "A", "a.B", "1a", "a.1b", "a-b", "a b", "a\n", "_a", "a._b"];
    for (const name of accepted) expect(isCapabilityName(name)).toBe(true);
    for (const name of rejected) expect(isCapabilityName(name)).toBe(false);
  });
});

const SHOP: Source = {
  ref: "shop-folder",
  kind: "folder",
  body: "Folder: /home/zach/Developer/shop\nsrc/measure.ts: measurePage (L3)\nsrc/brand.ts: conformBrand (L9)",
  anchors: ["src/measure.ts", "src/brand.ts"],
  truncated: false,
};
const NOTES: Source = { ref: "notes.md", kind: "file", body: "1. measure the page\n2. render a report", anchors: ["notes.md"], truncated: false };

const leaf = (name: string): Leaf => ({
  name,
  purpose: `Does ${name}.`,
  reason: `Someone runs ${name} on demand.`,
  input_summary: `input of ${name}`,
  output_summary: `output of ${name}`,
  input_fields: [`${name.split(".").at(-1)}_input`],
  output_fields: [`${name.split(".").at(-1)}_output`],
  kind: "deterministic",
  evidence: ["src/measure.ts:3"],
});

const inputOf = (prompt: string): string => prompt.slice(prompt.lastIndexOf("\nPrompt:\n"));
const purposeOf = (prompt: string): string => {
  const field = /^## (\w+)/.exec(prompt)?.[1];
  return ({ Capabilities: "propose", Clusters: "reconcile", Verdicts: "confirm", Pseudocode: "pseudocode", Distinct: "distinct" } as Record<string, string>)[field ?? ""] ?? "unknown";
};

/** A fake model: every source proposes `proposals[source ref]`; a leaf's pseudocode is written unless `noPseudocode` names it. */
function fakeModel(proposals: Record<string, readonly Leaf[]>, options: { noPseudocode?: boolean } = {}) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const shown = inputOf(prompt);
    switch (purposeOf(prompt)) {
      case "confirm":
        return JSON.stringify({
          Verdicts: [...shown.matchAll(/^Capability: (\S+)$/gm)].map((match) => ({
            name: match[1],
            pass: true,
            failed_criteria: [],
            objection: "",
            rename_to: "",
          })),
        });
      case "pseudocode": {
        if (options.noPseudocode) throw new Error("pseudocode is not available");
        const name = [...shown.matchAll(/Capability: (\S+)/g)].at(-1)?.[1] ?? "";
        const last = name.split(".").at(-1);
        return JSON.stringify({
          Pseudocode: {
            input: `{ ${last}_input: string }`,
            steps: [{ kind: "host", line: "gather the input" }, { kind: "det", line: `compute ${name}` }],
            output: `{ ${last}_output: string }`,
            apply: "nothing",
          },
        });
      }
      case "distinct":
        return JSON.stringify({ Distinct: true });
      default: {
        const ref = Object.keys(proposals).find((candidate) => shown.includes(candidate === "shop-folder" ? "Folder: /home/zach/Developer/shop" : "measure the page"));
        return JSON.stringify({ Capabilities: (proposals[ref ?? ""] ?? []).map((each) => ({ ...each, evidence: [ref === "notes.md" ? "notes.md" : "src/measure.ts"] })) });
      }
    }
  };
  return { step, prompts };
}

class FakeMachine implements Machine {
  readonly homeDirectory = "/home/zach";
  readonly workingDirectory = "/work";
  constructor(private readonly directories: readonly string[] = ["/work", "/home/zach/Developer/shop"]) {}
  async readTextFile(): Promise<string | undefined> {
    return undefined;
  }
  async isDirectory(path: string): Promise<boolean> {
    return this.directories.includes(path);
  }
  async listDirectory(): Promise<DirEntry[]> {
    return [];
  }
}

function world(proposals: Record<string, readonly Leaf[]>, options: { noPseudocode?: boolean } = {}) {
  const model = fakeModel(proposals, options);
  const deps: CreateWorkflowDeps = { step: model.step, machine: new FakeMachine(), workingDirectory: "/work" };
  const run = (input: Partial<CreateWorkflowInput> & Pick<CreateWorkflowInput, "sources">) =>
    runCreateWorkflow({ samples: 1, min_agreement: 1, ...input }, deps);
  return { run, prompts: model.prompts };
}

const TWO = { "shop-folder": [leaf("shop.page.measure"), leaf("shop.brand.conform")], "notes.md": [leaf("shop.page.measure"), leaf("shop.report.render")] };

describe("create_workflow", () => {
  it("proposes the leaves of every source and turns each into an implement_code request in run order", async () => {
    const { run } = world(TWO);
    const output = await run({ sources: [SHOP, NOTES], repo: "/home/zach/Developer/shop", hints: { near: "src/tools", language: "typescript" } });
    expect(output.implement_requests.map((entry) => [entry.source, entry.name])).toEqual([
      ["shop-folder", "shop.page.measure"],
      ["shop-folder", "shop.brand.conform"],
      ["notes.md", "shop.report.render"],
    ]);
    const first = output.implement_requests[0]!.request;
    expect(first).toMatchObject({
      design: { name: "shop.page.measure", purpose: "Does shop.page.measure.", input_summary: "input of shop.page.measure", output_summary: "output of shop.page.measure" },
      repo: "/home/zach/Developer/shop",
      hints: { near: "src/tools", language: "typescript" },
    });
    expect(first.design.pseudocode).toContain("compute shop.page.measure");
    expect(output.proposal.runs).toHaveLength(2);
    expect(output.totals).toMatchObject({ leaves: 4, requests: 3, unplanned: 0, duplicates: 1 });
    expect(output.totals.calls.pseudocode).toBe(4);
  });

  it("plans a leaf proposed by two sources once, at the first, and reports the repeat", async () => {
    const output = await world(TWO).run({ sources: [SHOP, NOTES] });
    expect(output.duplicates).toEqual([{ name: "shop.page.measure", source: "notes.md", first_source: "shop-folder" }]);
    expect(output.implement_requests.filter((entry) => entry.name === "shop.page.measure")).toHaveLength(1);
    // the repeat stays listed under its own source in the proposal
    expect(output.proposal.runs[1]!.capabilities.map((each) => each.name)).toContain("shop.page.measure");
  });

  it("caps the plan at max_leaves in run order and lists the rest as unplanned, not failed", async () => {
    const output = await world(TWO).run({ sources: [SHOP, NOTES], max_leaves: 2 });
    expect(output.implement_requests.map((entry) => entry.name)).toEqual(["shop.page.measure", "shop.brand.conform"]);
    expect(output.unplanned).toEqual([{ source: "notes.md", name: "shop.report.render", reason: "beyond max_leaves" }]);
    expect(output.totals).toMatchObject({ requests: 2, unplanned: 1 });
  });

  it("makes no requests for a phase 1 proposal, and says why for each leaf", async () => {
    const { run, prompts } = world(TWO);
    const output = await run({ sources: [SHOP], phase: 1 });
    expect(output.implement_requests).toEqual([]);
    expect(output.unplanned.map((entry) => entry.name)).toEqual(["shop.page.measure", "shop.brand.conform"]);
    expect(output.unplanned[0]!.reason).toMatch(/^no pseudocode/);
    expect(prompts.map(purposeOf)).not.toContain("pseudocode");
  });

  it("defaults the repo to the working directory and expands ~ and relative paths", async () => {
    const { run } = world(TWO);
    expect((await run({ sources: [SHOP] })).repo).toBe("/work");
    const machine = new FakeMachine(["/work", "/home/zach/Developer/shop", "/work/sub"]);
    const model = fakeModel(TWO);
    const deps: CreateWorkflowDeps = { step: model.step, machine, workingDirectory: "/work" };
    expect((await runCreateWorkflow({ sources: [SHOP], samples: 1, min_agreement: 1, repo: "~/Developer/shop" }, deps)).repo).toBe("/home/zach/Developer/shop");
    expect((await runCreateWorkflow({ sources: [SHOP], samples: 1, min_agreement: 1, repo: "sub" }, deps)).repo).toBe("/work/sub");
  });

  it("refuses a missing repo, a bad max_leaves, bad hints and a bad propose argument before any model call", async () => {
    const { run, prompts } = world(TWO);
    await expect(run({ sources: [SHOP], repo: "/no/such/repo" })).rejects.toThrow(/repo \/no\/such\/repo is not an existing directory/);
    await expect(run({ sources: [SHOP], max_leaves: 0 })).rejects.toThrow(/max_leaves must be a whole number >= 1/);
    await expect(run({ sources: [SHOP], hints: { near: " " } })).rejects.toThrow(/hints.near/);
    await expect(run({ sources: [] })).rejects.toThrow(/sources must name at least one/);
    await expect(run({ sources: [SHOP], samples: 9 })).rejects.toThrow(/samples/);
    expect(prompts).toEqual([]);
  });

  it("treats null hints and empty hints as no hints", async () => {
    const { run } = world(TWO);
    const output = await run({ sources: [SHOP], hints: { near: null as never, language: null as never } });
    expect(output.implement_requests[0]!.request).not.toHaveProperty("hints");
  });

  it("fails the whole call when a model step fails, returning nothing partial", async () => {
    await expect(world(TWO, { noPseudocode: true }).run({ sources: [SHOP] })).rejects.toThrow();
  });
});

describe("leaf selection", () => {
  const capability = (name: string, pseudocode?: string): ProposedCapability => ({
    ...leaf(name),
    agreement: 3,
    members: [],
    ...(pseudocode === undefined ? {} : { pseudocode }),
  });
  const run = (source: string, names: string[]): SourceRun => ({
    source,
    kind: "file",
    samples: 3,
    capabilities: names.map((name) => capability(name, `steps of ${name}`)),
    merged: [],
    rejected: [],
    usage: { calls: { propose: 0, reconcile: 0, confirm: 0, pseudocode: 0 } },
  });

  it("keeps the first source of a repeated name and counts max_leaves over the first-seen leaves", () => {
    const { build, beyond, duplicates } = leavesToBuild([run("a", ["x.one", "x.two"]), run("b", ["x.two", "y.three"])], 2);
    expect(build.map((entry) => entry.leaf.name)).toEqual(["x.one", "x.two"]);
    expect(beyond.map((entry) => entry.leaf.name)).toEqual(["y.three"]);
    expect(duplicates).toEqual([{ name: "x.two", source: "b", first_source: "a" }]);
  });

  it("builds a design only from a leaf that has pseudocode", () => {
    expect(designOf(capability("x.one"))).toBeUndefined();
    expect(designOf(capability("x.one", "do it"))).toEqual({
      name: "x.one",
      purpose: "Does x.one.",
      input_summary: "input of x.one",
      output_summary: "output of x.one",
      pseudocode: "do it",
    });
    const { planned, unplanned } = plan([{ source: "a", leaf: capability("x.one") }], [], "/r", undefined);
    expect(planned).toEqual([]);
    expect(unplanned).toHaveLength(1);
  });
});

describe("the tool", () => {
  function pi(exec: unknown = async () => ({ stdout: "", stderr: "", code: 0, killed: false })) {
    const schema = (kind: string) => {
      const chain: unknown = new Proxy({ kind }, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
      return chain;
    };
    const zod = new Proxy({}, { get: (_t, kind) => () => schema(String(kind)) });
    return { zod, exec, cwd: "/", logger: {} } as never;
  }
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<unknown>;
  };

  it("describes itself in 80 to 250 words, naming its siblings, and says it builds nothing", () => {
    const tool = factory(pi()) as unknown as Tool;
    expect(tool.name).toBe("create_workflow");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["propose_capabilities", "implement_code"]) expect(DESCRIPTION).toContain(sibling);
    expect(DESCRIPTION).toContain("builds and writes nothing");
  });

  it("fails on a source that cannot be read, before any model process is started", async () => {
    let spawned = 0;
    const tool = factory(pi(async () => {
      spawned += 1;
      return { stdout: "x", stderr: "", code: 0, killed: false };
    })) as unknown as Tool;
    await expect(tool.execute("t1", { sources: ["/no/such/source/anywhere"], repo: "/" }, undefined, undefined)).rejects.toThrow();
    expect(spawned).toBe(0);
  });
});
