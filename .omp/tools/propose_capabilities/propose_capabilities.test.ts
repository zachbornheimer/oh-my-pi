import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { MAX_NAME_CHARS, BANNED_LAST_WORDS, nameProblem } from "./capability_name.js";
import { MAX_OBJECTION_CHARS, NOT_DISTINCT_OBJECTION, verdictsProblem } from "./confirm.js";
import { type AgreedLeaf, agreementOf, partitionByAgreement, requiredAgreement } from "./consensus.js";
import type { ProposeDeps } from "./context.js";
import factory from "./index.js";
import type { DirEntry, Machine } from "./machine.js";
import { limitStep, type Exec, type ModelStep } from "./omp_model.js";
import { MAX_LEAVES, proposalProblem, registeredSiblings } from "./proposal_checks.js";
import { optionsFrom, runProposeCapabilities } from "./propose.js";
import {
  MAX_PSEUDOCODE_LINES,
  MAX_PSEUDOCODE_STEPS,
  type Pseudocode,
  pseudocodeProblem,
  renderPseudocode,
} from "./pseudocode.js";
import { clustersFrom, singleSampleClusters } from "./reconcile.js";
import { installedToolNames } from "./registered.js";
import type { Leaf, ProposeCapabilitiesInput, ProposeCapabilitiesOutput, Source } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// A world: sources, leaves and a fake model that answers by what it is shown (no real model, no network).
// ---------------------------------------------------------------------------------------------------------------

const SHOP: Source = {
  ref: "~/Developer/shop",
  kind: "folder",
  body: "Folder: /home/zach/Developer/shop\n# Code\nsrc/measure.ts: measurePage (L3)\nsrc/brand.ts: conformBrand (L9)",
  anchors: ["README.md", "src/measure.ts", "src/brand.ts", "src/report.ts"],
  truncated: false,
};

const NOTES: Source = {
  ref: "claude:abc",
  kind: "conversation",
  body: '[1] user: measure every page\n[2] tool Bash: {"command":"measure --all"}',
  anchors: ["1", "2"],
  truncated: false,
};

const leaf = (name: string, extra: Partial<Leaf> = {}): Leaf => ({
  name,
  purpose: `Does ${name}.`,
  reason: `Someone runs ${name} on demand.`,
  input_summary: `input of ${name}`,
  output_summary: `output of ${name}`,
  input_fields: [`${name.split(".").at(-1)}_input`],
  output_fields: [`${name.split(".").at(-1)}_output`],
  kind: "deterministic",
  evidence: ["src/measure.ts:3"],
  ...extra,
});

/** The proposal the fake model makes for every source unless a test says otherwise. */
const DEFAULT_PROPOSAL: readonly Leaf[] = [
  leaf("shop.page.measure"),
  leaf("shop.brand.conform", { kind: "model", evidence: ["src/brand.ts"] }),
  leaf("shop.report.render"),
];

/** What a model reads of a prompt: the text after the question's own examples, i.e. after the last "Prompt:" line. */
const inputOf = (prompt: string): string => prompt.slice(prompt.lastIndexOf("\nPrompt:\n"));

/** Which question a prompt asks. */
const purposeOf = (prompt: string): string => {
  const field = /^## (\w+)/.exec(prompt)?.[1];
  return ({ Capabilities: "propose", Clusters: "reconcile", Verdicts: "confirm", Pseudocode: "pseudocode", Distinct: "distinct" } as Record<string, string>)[field ?? ""] ?? "unknown";
};

/** The leaves with evidence that exists in whichever source the prompt shows: a turn for a conversation, else a path. */
const citedIn = (prompt: string, leaves: readonly Leaf[]): Leaf[] =>
  inputOf(prompt).includes("(conversation)") ? leaves.map((each) => ({ ...each, evidence: ["2"] })) : [...leaves];

const nameIn = (prompt: string): string => [...inputOf(prompt).matchAll(/Capability: (\S+)/g)].at(-1)?.[1] ?? "";

const namesInVerdictPrompt = (prompt: string): string[] =>
  [...inputOf(prompt).matchAll(/^Capability: (\S+)$/gm)].map((match) => match[1]!);

function pseudocodeFor(prompt: string): string {
  const name = nameIn(prompt);
  const leafKind = [...inputOf(prompt).matchAll(/Kind: (\w+)/g)].at(-1)?.[1];
  const kind = leafKind === "model" ? "model" : "det";
  const last = name.split(".").at(-1);
  return JSON.stringify({
    Pseudocode: {
      input: `{ ${last}_input: string }`,
      steps: [{ kind: "host", line: "gather the input" }, { kind, line: `compute ${name}` }],
      output: `{ ${last}_output: string }`,
      apply: "nothing",
    },
  });
}

interface ShownProposal {
  readonly sample: number;
  readonly name: string;
  readonly kind: string;
  readonly purpose: string;
  readonly input_fields: string[];
  readonly output_fields: string[];
  readonly evidence: string[];
}

const fieldsOf = (block: string, label: string): string[] =>
  (block.match(new RegExp(`^${label}: (.*)$`, "m"))?.[1] ?? "").split(", ");

function proposalsInReconcilePrompt(prompt: string): ShownProposal[] {
  return inputOf(prompt).split(/\n\n(?=Sample \d+ \| )/).flatMap((block) => {
    const head = block.match(/Sample (\d+) \| (\S+)/);
    if (head === null) return [];
    return [{
      sample: Number(head[1]),
      name: head[2]!,
      kind: block.match(/^Kind: (\w+)$/m)?.[1] ?? "deterministic",
      purpose: block.match(/^Purpose: (.*)$/m)?.[1] ?? "",
      input_fields: fieldsOf(block, "Input fields"),
      output_fields: fieldsOf(block, "Output fields"),
      evidence: fieldsOf(block, "Evidence"),
    }];
  });
}

/** The reconcile reply that groups proposals by their canonical name; `canonical` maps a proposed name to its concept's name. */
function clustersFor(proposals: readonly ShownProposal[], canonical: Readonly<Record<string, string>> = {}): string {
  const byName = new Map<string, ShownProposal[]>();
  for (const proposal of proposals) {
    const name = canonical[proposal.name] ?? proposal.name;
    byName.set(name, [...(byName.get(name) ?? []), proposal]);
  }
  return JSON.stringify({
    Clusters: [...byName].map(([name, members]) => ({
      name,
      purpose: members[0]!.purpose,
      kind: members[0]!.kind,
      input_fields: members[0]!.input_fields,
      output_fields: members[0]!.output_fields,
      evidence: members[0]!.evidence,
      members: members.map((member) => ({ sample: member.sample, name: member.name })),
    })),
  });
}

interface Objection {
  readonly criteria: readonly string[];
  readonly objection: string;
}

function verdictsFor(
  names: readonly string[],
  objections: Readonly<Record<string, Objection>> = {},
  renames: Readonly<Record<string, string>> = {},
): string {
  return JSON.stringify({
    Verdicts: names.map((name) => {
      const against = objections[name];
      return against === undefined
        ? { name, pass: true, failed_criteria: [], objection: "", rename_to: renames[name] ?? "" }
        : { name, pass: false, failed_criteria: against.criteria, objection: against.objection, rename_to: renames[name] ?? "" };
    }),
  });
}

interface WorldOptions {
  /** The proposal every sample makes unless `samples` says otherwise. */
  readonly proposal?: readonly Leaf[];
  /** The proposal of each sample, in the order the samples ask; the last one repeats if more samples ask. */
  readonly samples?: readonly (readonly Leaf[])[];
  readonly objections?: Readonly<Record<string, Objection>>;
  readonly canonical?: Readonly<Record<string, string>>;
  readonly reconcile?: (proposals: readonly ShownProposal[], call: number) => string;
  readonly renames?: Readonly<Record<string, string>>;
  readonly verdicts?: (names: readonly string[], call: number) => string;
  /** Whether the model says a leaf is distinct from the registered ones, by name; every other answer is true. */
  readonly registeredDistinct?: Readonly<Record<string, boolean>>;
  readonly pseudocode?: (prompt: string) => string;
  /** The first replies, in order, replacing the proposals' (for a model that answers badly first). */
  readonly proposalReplies?: readonly string[];
}

/** What the fake model answers to each kind of prompt. */
function responder(options: WorldOptions = {}): (prompt: string) => string {
  let proposals = 0;
  let verdictCalls = 0;
  let reconcileCalls = 0;
  return (prompt) => {
    switch (purposeOf(prompt)) {
      case "pseudocode":
        return (options.pseudocode ?? pseudocodeFor)(prompt);
      case "reconcile": {
        const shown = proposalsInReconcilePrompt(prompt);
        return options.reconcile?.(shown, ++reconcileCalls) ?? clustersFor(shown, options.canonical);
      }
      case "confirm": {
        const names = namesInVerdictPrompt(prompt);
        return options.verdicts?.(names, ++verdictCalls) ?? verdictsFor(names, options.objections, options.renames);
      }
      case "distinct":
        return JSON.stringify({ Distinct: options.registeredDistinct?.[nameIn(prompt)] ?? true });
      default: {
        const asked = proposals++;
        const scripted = options.proposalReplies?.[asked];
        if (scripted !== undefined) return scripted;
        const sample = options.samples?.[Math.min(asked, options.samples.length - 1)];
        return JSON.stringify({ Capabilities: citedIn(prompt, sample ?? options.proposal ?? DEFAULT_PROPOSAL) });
      }
    }
  };
}

/** An in-memory filesystem: files by absolute path; a directory is any prefix of one. */
class FakeMachine implements Machine {
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string> = {}, home = "/home/zach", cwd = "/work") {
    this.homeDirectory = home;
    this.workingDirectory = cwd;
  }
  async readTextFile(path: string): Promise<string | undefined> {
    this.reads.push(path);
    return this.files[path];
  }
  async isDirectory(path: string): Promise<boolean> {
    return Object.keys(this.files).some((file) => file.startsWith(`${path}/`));
  }
  async listDirectory(path: string): Promise<DirEntry[]> {
    const names = new Map<string, boolean>();
    for (const file of Object.keys(this.files)) {
      if (!file.startsWith(`${path}/`)) continue;
      const [head, ...rest] = file.slice(path.length + 1).split("/");
      names.set(head!, rest.length > 0);
    }
    return [...names].map(([name, directory]) => ({ name, directory })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

function proposeCapabilitiesWorld(options: WorldOptions = {}, machine: Machine = new FakeMachine()) {
  const prompts: string[] = [];
  const respond = responder(options);
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    return respond(prompt);
  };
  const run = (input: ProposeCapabilitiesInput, extra: Partial<ProposeDeps> = {}): Promise<ProposeCapabilitiesOutput> =>
    runProposeCapabilities(input, { step, machine, ...extra });
  const purposes = (): string[] => prompts.map(purposeOf);
  return { run, prompts, purposes, step };
}

const names = (capabilities: readonly { name: string }[]): string[] => capabilities.map((each) => each.name);
const members = (name: string, samples = [1, 2, 3]) => samples.map((sample) => ({ sample, name }));

// ---------------------------------------------------------------------------------------------------------------
// Phase 1
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities phase 1", () => {
  it("keeps the concepts enough samples proposed that the model passed, and says why the rest went", async () => {
    const output = await proposeCapabilitiesWorld({
      objections: {
        "shop.report.render": { criteria: ["useful"], objection: "A renderer of another result, not a capability." },
      },
    }).run({ sources: [SHOP], phase: 1 });
    const [run] = output.runs;
    expect(names(run!.capabilities)).toEqual(["shop.page.measure", "shop.brand.conform"]);
    expect(run!.merged).toEqual([]);
    expect(run!.rejected).toEqual([{
      name: "shop.report.render",
      objection: "A renderer of another result, not a capability.",
      failed_criteria: ["useful"],
      agreement: 3,
      members: members("shop.report.render"),
    }]);
    expect(output.totals).toMatchObject({ sources: 1, kept: 2, merged: 0, rejected: 1 });
  });

  it("returns every field of a kept leaf, how many samples agreed on it, and no pseudocode", async () => {
    const output = await proposeCapabilitiesWorld().run({ sources: [SHOP], phase: 1 });
    expect(output.runs[0]!.capabilities[0]).toEqual({
      ...DEFAULT_PROPOSAL[0]!,
      agreement: 3,
      members: members("shop.page.measure"),
    });
    expect(output.runs[0]!.samples).toBe(3);
    expect(output.registered).toEqual([]);
  });

  it("asks three times to propose, once to reconcile and once to confirm all of them, and nothing else", async () => {
    const world = proposeCapabilitiesWorld();
    const output = await world.run({ sources: [SHOP], phase: 1 });
    expect(world.purposes()).toEqual(["propose", "propose", "propose", "reconcile", "confirm"]);
    expect(output.runs[0]!.usage.calls).toEqual({ propose: 3, reconcile: 1, confirm: 1, pseudocode: 0 });
  });

  it("makes the number of samples an input, and skips the reconcile call for one sample", async () => {
    const one = proposeCapabilitiesWorld();
    const output = await one.run({ sources: [SHOP], phase: 1, samples: 1 });
    expect(one.purposes().filter((purpose) => purpose === "propose")).toHaveLength(1);
    expect(one.purposes()).not.toContain("reconcile");
    expect(output.runs[0]).toMatchObject({ samples: 1, usage: { calls: { propose: 1, reconcile: 0, confirm: 1 } } });
    expect(output.runs[0]!.capabilities.every((each) => each.agreement === 1)).toBe(true);
    await expect(one.run({ sources: [SHOP], samples: 0 })).rejects.toThrow(/samples/);
  });

  it("keeps a concept two of three samples proposed under different names, named once", async () => {
    const output = await proposeCapabilitiesWorld({
      samples: [
        [leaf("shop.page.measure"), leaf("shop.brand.conform")],
        [leaf("shop.page.measure_score")],
        [leaf("shop.page.speed"), leaf("shop.report.render")],
      ],
      canonical: { "shop.page.measure_score": "shop.page.measure", "shop.page.speed": "shop.page.measure" },
    }).run({ sources: [SHOP], phase: 1 });
    const [run] = output.runs;
    expect(run!.capabilities.map((each) => [each.name, each.agreement])).toEqual([["shop.page.measure", 3]]);
    expect(run!.merged).toEqual([
      { name: "shop.page.measure_score", into: "shop.page.measure" },
      { name: "shop.page.speed", into: "shop.page.measure" },
    ]);
    expect(run!.rejected.map((each) => [each.name, each.objection, each.agreement])).toEqual([
      ["shop.brand.conform", "proposed by 1 of 3 samples", 1],
      ["shop.report.render", "proposed by 1 of 3 samples", 1],
    ]);
    expect(run!.rejected[1]!.members).toEqual([{ sample: 3, name: "shop.report.render" }]);
  });

  it("asks for the agreement min_agreement names", async () => {
    const samples = [[leaf("shop.page.measure"), leaf("shop.brand.conform")], [leaf("shop.page.measure")], [
      leaf("shop.page.measure"),
      leaf("shop.brand.conform"),
    ]];
    const strict = await proposeCapabilitiesWorld({ samples }).run({ sources: [SHOP], phase: 1, min_agreement: 3 });
    expect(names(strict.runs[0]!.capabilities)).toEqual(["shop.page.measure"]);
    expect(strict.runs[0]!.rejected[0]).toMatchObject({ name: "shop.brand.conform", objection: "proposed by 2 of 3 samples" });
    const loose = await proposeCapabilitiesWorld({
      samples: [[leaf("shop.page.measure")], [leaf("shop.brand.conform")], [leaf("shop.report.render")]],
    }).run({ sources: [SHOP], phase: 1, min_agreement: 1 });
    expect(loose.runs[0]!.capabilities).toHaveLength(3);
  });

  it("asks again, showing why, when the reconciliation invents a member or leaves a proposal out", async () => {
    const world = proposeCapabilitiesWorld({
      reconcile: (proposals, call) =>
        call === 1
          ? JSON.stringify({
            Clusters: [{
              name: "shop.page.measure",
              purpose: "x",
              kind: "deterministic",
              input_fields: ["a"],
              output_fields: ["b"],
              evidence: ["src/measure.ts:3"],
              members: [{ sample: 1, name: "shop.page.invented" }],
            }],
          })
          : call === 2
          ? clustersFor(proposals.filter((proposal) => proposal.name !== "shop.report.render"))
          : clustersFor(proposals),
    });
    const output = await world.run({ sources: [SHOP], phase: 1 });
    const asked = world.prompts.filter((prompt) => purposeOf(prompt) === "reconcile");
    expect(asked).toHaveLength(3);
    expect(asked[1]).toMatch(/lists "shop.page.invented" as sample 1's proposal, which it is not/);
    expect(asked[2]).toMatch(/proposals are in no cluster/);
    expect(output.runs[0]!.capabilities).toHaveLength(3);
  });

  it("asks nothing to confirm when no concept has enough samples", async () => {
    const world = proposeCapabilitiesWorld({
      samples: [[leaf("shop.page.measure")], [leaf("shop.page.audit")], [leaf("shop.brand.conform")]],
    });
    const output = await world.run({ sources: [SHOP], phase: 1 });
    expect(world.purposes()).toEqual(["propose", "propose", "propose", "reconcile"]);
    expect(output.runs[0]!.rejected).toHaveLength(3);
    expect(output.runs[0]!.usage.calls.confirm).toBe(0);
  });

  it("asks the model again, showing why, when a name says how", async () => {
    const world = proposeCapabilitiesWorld({
      proposalReplies: [JSON.stringify({ Capabilities: [leaf("shop.page.measure_with_llm")] })],
    });
    const output = await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    expect(world.prompts[1]).toMatch(/says how, not what \("with"\)/);
    expect(world.prompts[1]).toContain("Your previous reply was rejected");
    expect(output.runs[0]!.capabilities).toHaveLength(3);
  });

  it("asks again, showing why, when a name ends in a filler verb", async () => {
    const world = proposeCapabilitiesWorld({
      proposalReplies: [JSON.stringify({ Capabilities: [leaf("shop.page.check")] })],
      proposal: [leaf("shop.page.measure")],
    });
    const output = await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    expect(world.prompts[1]).toMatch(/ends in the filler verb "check"/);
    expect(names(output.runs[0]!.capabilities)).toEqual(["shop.page.measure"]);
  });

  it("asks again when the reply is not JSON, an object without the key, or has a wrong field", async () => {
    const world = proposeCapabilitiesWorld({
      proposalReplies: [
        "Here are some capabilities!",
        JSON.stringify({ capabilities: [] }),
        JSON.stringify({ Capabilities: [{ ...leaf("shop.page.measure"), kind: "magic" }] }),
      ],
      proposal: [leaf("shop.page.measure")],
    });
    await expect(world.run({ sources: [SHOP], phase: 1, samples: 1 })).rejects.toThrow(
      /no valid reply after 3 attempts: Capabilities\[0\]\.kind must be one of deterministic, model, host/,
    );
    expect(world.prompts[1]).toMatch(/the reply is not JSON/);
    expect(world.prompts[2]).toMatch(/has no "Capabilities" key/);
  });

  it("states the filler verb rule with good and bad names in what the proposal reads", async () => {
    const world = proposeCapabilitiesWorld();
    await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    const prompt = world.prompts[0]!;
    expect(prompt).toContain("run, check, handle, process, do, manage, execute, perform, fetch, get");
    for (const pair of ['"uptime.check" is wrong, "site.uptime" is right', '"page.fetch" is wrong', '"code.audit.run" is wrong']) {
      expect(prompt).toContain(pair);
    }
  });

  it("refuses evidence that is not in the source, and a name outside the namespace", async () => {
    const wrongEvidence = proposeCapabilitiesWorld({ proposal: [leaf("shop.page.measure", { evidence: ["src/nowhere.ts:1"] })] });
    await expect(wrongEvidence.run({ sources: [SHOP], phase: 1 })).rejects.toThrow(/cites "src\/nowhere.ts:1"/);
    const wrongNamespace = proposeCapabilitiesWorld();
    await expect(wrongNamespace.run({ sources: [SHOP], phase: 1, namespace: "webmaster" })).rejects.toThrow(
      /must start with "webmaster\."/,
    );
  });

  it("refuses a duplicate name, no leaves and more leaves than it will read", async () => {
    const twice = proposeCapabilitiesWorld({ proposal: [leaf("shop.page.measure"), leaf("shop.page.measure")] });
    await expect(twice.run({ sources: [SHOP], phase: 1 })).rejects.toThrow(/"shop.page.measure" is listed twice/);
    await expect(proposeCapabilitiesWorld({ proposal: [] }).run({ sources: [SHOP], phase: 1 })).rejects.toThrow(
      /propose at least one capability/,
    );
    const flood = Array.from({ length: MAX_LEAVES + 1 }, (_, index) => leaf(`shop.page.measure_${index}`));
    await expect(proposeCapabilitiesWorld({ proposal: flood }).run({ sources: [SHOP], phase: 1 })).rejects.toThrow(
      new RegExp(`at most ${MAX_LEAVES}`),
    );
  });

  it("takes a turn number as evidence for a conversation and a path with a line for a folder", async () => {
    const conversation = proposeCapabilitiesWorld({ proposal: [leaf("shop.page.measure", { evidence: ["turn 2", "2"] })] });
    await expect(conversation.run({ sources: [NOTES], phase: 1 })).resolves.toBeDefined();
    const folder = proposeCapabilitiesWorld({ proposal: [leaf("shop.page.measure", { evidence: ["src/measure.ts:3-9"] })] });
    await expect(folder.run({ sources: [SHOP], phase: 1 })).resolves.toBeDefined();
  });

  it("puts the namespace and the cut notice in what the model reads", async () => {
    const world = proposeCapabilitiesWorld();
    await world.run({ sources: [{ ...SHOP, truncated: true }], phase: 1, namespace: "shop" });
    const prompt = world.prompts[0]!;
    expect(prompt).toContain('Namespace: every name starts with "shop."');
    expect(prompt).toContain("cut at its size limit");
    expect(prompt).toContain(SHOP.body);
  });

  it("shows the model the examples, the schema and the instruction to answer with JSON only", async () => {
    const world = proposeCapabilitiesWorld();
    await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    const prompt = world.prompts[0]!;
    expect(prompt.startsWith("## Capabilities\n")).toBe(true);
    expect(prompt).toContain("Answer:\n{");
    expect(prompt).toContain("photo.duplicate.find");
    expect(prompt).toContain("Respond with only one JSON object matching this schema");
    expect(prompt).toContain('"required":["Capabilities"]');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Registered capabilities
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities against registered capabilities", () => {
  const registered = ["shop.page.audit", "shop.page.seo", "other.thing"];

  it("shows the proposal the registered names under the namespace, and only those", async () => {
    const world = proposeCapabilitiesWorld();
    const output = await world.run({ sources: [SHOP], phase: 1, namespace: "shop", registered });
    const prompt = world.prompts[0]!;
    expect(prompt).toContain("Registered capabilities (they exist already):\n- shop.page.audit\n- shop.page.seo");
    expect(prompt).not.toContain("other.thing");
    expect(output.registered).toEqual(["shop.page.audit", "shop.page.seo"]);
  });

  it("shows nothing registered when the namespace has none, or there is no namespace", async () => {
    const world = proposeCapabilitiesWorld();
    await world.run({ sources: [SHOP], phase: 1, namespace: "shop", registered: ["other.thing"] });
    await world.run({ sources: [SHOP], phase: 1, registered });
    expect(world.prompts.some((prompt) => prompt.includes("Registered capabilities (they exist"))).toBe(false);
    expect(world.purposes()).not.toContain("distinct");
  });

  it("refuses a proposal that repeats a registered name", async () => {
    const world = proposeCapabilitiesWorld();
    await expect(
      world.run({ sources: [SHOP], phase: 1, namespace: "shop", registered: ["shop.page.measure"] }),
    ).rejects.toThrow(/"shop.page.measure" is already a registered capability/);
  });

  it("asks the model once per passing leaf whether it differs from the registered ones, and takes its yes or no", async () => {
    const world = proposeCapabilitiesWorld({ registeredDistinct: { "shop.report.render": false } });
    const output = await world.run({ sources: [SHOP], phase: 1, namespace: "shop", registered });
    expect(world.purposes().filter((purpose) => purpose === "distinct")).toHaveLength(3);
    expect(names(output.runs[0]!.capabilities)).toEqual(["shop.page.measure", "shop.brand.conform"]);
    expect(output.runs[0]!.rejected).toEqual([{
      name: "shop.report.render",
      objection: NOT_DISTINCT_OBJECTION,
      failed_criteria: ["distinct"],
      agreement: 3,
      members: members("shop.report.render"),
    }]);
    expect(output.runs[0]!.usage.calls.confirm).toBe(4);
  });

  it("refuses a distinct answer that is not a boolean", async () => {
    const world = proposeCapabilitiesWorld();
    const base = world.step;
    const step: ModelStep = async (prompt, signal) =>
      purposeOf(prompt) === "distinct" ? JSON.stringify({ Distinct: 0.9 }) : base(prompt, signal);
    await expect(
      runProposeCapabilities({ sources: [SHOP], phase: 1, namespace: "shop", registered }, { step, machine: new FakeMachine() }),
    ).rejects.toThrow(/Distinct must be true or false, got 0.9/);
  });

  it("checks a renamed leaf against the registered capabilities under its new name", async () => {
    const world = proposeCapabilitiesWorld({
      renames: { "shop.page.measure": "shop.page.speed" },
      registeredDistinct: { "shop.page.speed": false },
    });
    const output = await world.run({ sources: [SHOP], phase: 1, namespace: "shop", registered: ["shop.page.audit"] });
    expect(output.runs[0]!.rejected[0]).toMatchObject({ name: "shop.page.speed", failed_criteria: ["distinct"] });
  });

  it("lists the installed omp tools under the namespace when no registered list is given, and uses a given list as it is", async () => {
    const tools = "/home/zach/.omp/agent/tools";
    const machine = new FakeMachine({
      [`${tools}/webmaster_site_dns/index.ts`]: "",
      [`${tools}/webmaster_sitemap.ts`]: "",
      [`${tools}/webmaster_sitemap.test.ts`]: "",
      [`${tools}/other_tool/index.ts`]: "",
      [`${tools}/_shared/x.ts`]: "",
    });
    expect(await installedToolNames(machine, "webmaster")).toEqual(["webmaster.site.dns", "webmaster.sitemap"]);
    const proposal = [leaf("webmaster.page.audit")];
    const world = proposeCapabilitiesWorld({ proposal }, machine);
    const output = await world.run({ sources: [SHOP], phase: 1, namespace: "webmaster" });
    expect(output.registered).toEqual(["webmaster.site.dns", "webmaster.sitemap"]);
    expect(world.prompts[0]).toContain("- webmaster.site.dns\n- webmaster.sitemap");
    const given = await world.run({ sources: [SHOP], phase: 1, namespace: "webmaster", registered: ["webmaster.keep"] });
    expect(given.registered).toEqual(["webmaster.keep"]);
    const none = await world.run({ sources: [SHOP], phase: 1, namespace: "webmaster", registered: [] });
    expect(none.registered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities confirmation", () => {
  it("asks again, showing why, when the verdicts are not JSON", async () => {
    const world = proposeCapabilitiesWorld({ verdicts: (leaves, call) => (call === 1 ? "I think they are all fine" : verdictsFor(leaves)) });
    const output = await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    const asked = world.prompts.filter((prompt) => purposeOf(prompt) === "confirm");
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("I think they are all fine");
    expect(output.runs[0]!.capabilities).toHaveLength(3);
  });

  it("asks again, showing why, when a leaf has no verdict or a verdict contradicts itself", async () => {
    const world = proposeCapabilitiesWorld({
      verdicts: (leaves, call) =>
        call === 1
          ? verdictsFor(leaves.slice(1))
          : call === 2
          ? JSON.stringify({ Verdicts: leaves.map((name) => ({ name, pass: true, failed_criteria: ["clear"], objection: "" })) })
          : verdictsFor(leaves),
    });
    const output = await world.run({ sources: [SHOP], phase: 1, samples: 1 });
    const asked = world.prompts.filter((prompt) => purposeOf(prompt) === "confirm");
    expect(asked[1]).toMatch(/no verdict for "shop.page.measure"/);
    expect(asked[2]).toMatch(/passes but lists failed criteria/);
    expect(output.runs[0]!.capabilities).toHaveLength(3);
  });

  it("fails the run, naming the reason, when the verdicts stay invalid", async () => {
    const world = proposeCapabilitiesWorld({ verdicts: () => "no" });
    await expect(world.run({ sources: [SHOP], phase: 1, samples: 1 })).rejects.toThrow(/no valid reply after 3 attempts/);
  });

  it("refuses a failed criterion it does not know", async () => {
    const world = proposeCapabilitiesWorld({
      verdicts: (leaves) => JSON.stringify({ Verdicts: leaves.map((name) => ({ name, pass: false, failed_criteria: ["shiny"], objection: "x" })) }),
    });
    await expect(world.run({ sources: [SHOP], phase: 1, samples: 1 })).rejects.toThrow(/failed_criteria\[0\] must be one of distinct/);
  });

  it("shows the confirming model every leaf with its purpose, and every verdict names its criteria", async () => {
    const world = proposeCapabilitiesWorld({
      objections: { "shop.brand.conform": { criteria: ["clear", "concise"], objection: "Says two things." } },
    });
    const output = await world.run({ sources: [SHOP], phase: 1 });
    const prompt = world.prompts.find((each) => purposeOf(each) === "confirm")!;
    expect(namesInVerdictPrompt(prompt)).toEqual(names(DEFAULT_PROPOSAL));
    expect(prompt).toContain("Purpose: Does shop.page.measure.");
    expect(output.runs[0]!.rejected[0]).toMatchObject({
      name: "shop.brand.conform",
      objection: "Says two things.",
      failed_criteria: ["clear", "concise"],
    });
  });
});

describe("verdictsProblem", () => {
  const leaves = [leaf("a.one"), leaf("a.two")];
  const pass = (name: string) => ({ name, pass: true, failed_criteria: [] as never[], objection: "" });
  const fail = (name: string, objection = "Too vague.") => ({ name, pass: false, failed_criteria: ["clear" as const], objection });

  it("accepts one consistent verdict per leaf", () => {
    expect(verdictsProblem([pass("a.one"), fail("a.two")], leaves)).toBeUndefined();
  });

  it.each([
    ["a name that was not proposed", [pass("a.one"), pass("a.two"), pass("a.three")], /"a.three" is not a proposed/],
    ["a leaf judged twice", [pass("a.one"), pass("a.one"), pass("a.two")], /"a.one" has two verdicts/],
    ["a leaf left out", [pass("a.one")], /no verdict for "a.two"/],
    ["a failure naming no criterion", [pass("a.one"), { ...fail("a.two"), failed_criteria: [] }], /list the criteria/],
    ["a failure without an objection", [pass("a.one"), fail("a.two", "  ")], /say what is wrong/],
    ["an objection that runs on", [pass("a.one"), fail("a.two", "x".repeat(MAX_OBJECTION_CHARS + 1))], /over 200 characters/],
  ])("refuses %s with a reason for the model", (_label, verdicts, reason) => {
    expect(verdictsProblem(verdicts, leaves)).toMatch(reason);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Renames
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities renames", () => {
  it("applies a passing leaf's better name once and records the old one", async () => {
    const output = await proposeCapabilitiesWorld({
      renames: { "shop.page.measure": "shop.page.speed", "shop.brand.conform": "shop.brand.conform" },
    }).run({ sources: [SHOP], phase: 1 });
    const [first, second] = output.runs[0]!.capabilities;
    expect([first!.name, first!.renamed_from]).toEqual(["shop.page.speed", "shop.page.measure"]);
    expect([second!.name, second!.renamed_from]).toEqual(["shop.brand.conform", undefined]);
  });

  it.each([
    ["a filler verb", "shop.page.run"],
    ["a name that says how", "shop.page.measure_with_llm"],
    ["a name outside the namespace", "other.page.speed"],
    ["another kept leaf's name", "shop.brand.conform"],
  ])("keeps the name when the better one is %s", async (_label, wanted) => {
    const output = await proposeCapabilitiesWorld({ renames: { "shop.page.measure": wanted } }).run({
      sources: [SHOP],
      phase: 1,
      namespace: "shop",
    });
    expect(names(output.runs[0]!.capabilities)).toEqual(names(DEFAULT_PROPOSAL));
    expect(output.runs[0]!.capabilities[0]!.renamed_from).toBeUndefined();
  });

  it("keeps a leaf that fails only on its name under the better name its verdict gives", async () => {
    const output = await proposeCapabilitiesWorld({
      objections: { "shop.page.measure": { criteria: ["clear", "concise"], objection: "Vague name." } },
      renames: { "shop.page.measure": "shop.page.speed" },
    }).run({ sources: [SHOP], phase: 1 });
    const [first] = output.runs[0]!.capabilities;
    expect([first!.name, first!.renamed_from]).toEqual(["shop.page.speed", "shop.page.measure"]);
    expect(output.runs[0]!.rejected).toEqual([]);
  });

  it.each([
    ["useful as well", ["clear", "useful"]],
    ["distinct", ["distinct"]],
  ])("rejects a leaf that fails on %s, whatever name its verdict gives", async (_label, criteria) => {
    const output = await proposeCapabilitiesWorld({
      objections: { "shop.page.measure": { criteria, objection: "Not a capability." } },
      renames: { "shop.page.measure": "shop.page.speed" },
    }).run({ sources: [SHOP], phase: 1 });
    expect(output.runs[0]!.rejected.map((each) => each.name)).toEqual(["shop.page.measure"]);
    expect(names(output.runs[0]!.capabilities)).not.toContain("shop.page.speed");
  });

  it("rejects a leaf that fails only on its name when the better name is itself refused", async () => {
    const output = await proposeCapabilitiesWorld({
      objections: { "shop.page.measure": { criteria: ["clear"], objection: "Vague name." } },
      renames: { "shop.page.measure": "shop.page.run" },
    }).run({ sources: [SHOP], phase: 1 });
    expect(output.runs[0]!.rejected[0]).toMatchObject({ name: "shop.page.measure", objection: "Vague name." });
  });

  it("rejects a leaf that fails only on its name when its verdict gives no better name", async () => {
    const output = await proposeCapabilitiesWorld({
      objections: { "shop.page.measure": { criteria: ["irreducible"], objection: "A word too many." } },
    }).run({ sources: [SHOP], phase: 1 });
    expect(output.runs[0]!.rejected.map((each) => each.name)).toEqual(["shop.page.measure"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 2
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities phase 2", () => {
  it("writes pseudocode for each kept leaf by default, one call each", async () => {
    const world = proposeCapabilitiesWorld({
      objections: { "shop.report.render": { criteria: ["useful"], objection: "A renderer." } },
    });
    const output = await world.run({ sources: [SHOP] });
    const capabilities = output.runs[0]!.capabilities;
    expect(names(capabilities)).toEqual(["shop.page.measure", "shop.brand.conform"]);
    expect(capabilities[0]!.pseudocode).toBe(
      [
        "input: { measure_input: string }",
        "1. [host] gather the input",
        "2. [det] compute shop.page.measure",
        "output: { measure_output: string }",
        "apply: nothing",
      ].join("\n"),
    );
    expect(capabilities[1]!.pseudocode).toContain("[model] compute shop.brand.conform");
    expect(world.purposes().filter((purpose) => purpose === "pseudocode")).toHaveLength(2);
    expect(output.totals.calls).toEqual({ propose: 3, reconcile: 1, confirm: 1, pseudocode: 2 });
  });

  it("stops after the list when phase is 1, and keeps phase 2 the default", async () => {
    const stopped = proposeCapabilitiesWorld();
    const first = await stopped.run({ sources: [SHOP], phase: 1 });
    expect(stopped.purposes()).not.toContain("pseudocode");
    expect(first.runs[0]!.capabilities.every((capability) => capability.pseudocode === undefined)).toBe(true);
    const full = proposeCapabilitiesWorld();
    await full.run({ sources: [SHOP], phase: 2 });
    expect(full.purposes()).toContain("pseudocode");
  });

  it("asks again, showing why, when the pseudocode leaves a field out", async () => {
    let first = true;
    const world = proposeCapabilitiesWorld({
      proposal: [leaf("shop.page.measure")],
      pseudocode: (prompt) => {
        if (!first) return pseudocodeFor(prompt);
        first = false;
        return JSON.stringify({
          Pseudocode: { input: "{ url: string }", steps: [{ kind: "det", line: "x" }], output: "{ y: string }", apply: "nothing" },
        });
      },
    });
    const output = await world.run({ sources: [SHOP] });
    expect(world.prompts.at(-1)).toMatch(/input field "measure_input"/);
    expect(output.runs[0]!.capabilities[0]!.pseudocode).toContain("measure_output");
  });
});

describe("pseudocodeProblem", () => {
  const measure = leaf("shop.page.measure", { input_fields: ["url"], output_fields: ["score", "issues"] });
  const sound = (): Pseudocode => ({
    input: "{ url: string }",
    steps: [{ kind: "host", line: "fetch the url" }, { kind: "det", line: "compute score and issues" }],
    output: "{ score: number, issues: string[] }",
    apply: "nothing",
  });

  it("accepts pseudocode that names every field and fits the kind", () => {
    expect(pseudocodeProblem(measure, sound())).toBeUndefined();
  });

  it("names the input field the input line leaves out", () => {
    expect(pseudocodeProblem(measure, { ...sound(), input: "{ link: string }" })).toMatch(/input field "url"/);
  });

  it("names the output field the output line leaves out, and matches whole identifiers only", () => {
    expect(pseudocodeProblem(measure, { ...sound(), output: "{ score: number, issues_found: string[] }" })).toMatch(
      /output field "issues"/,
    );
  });

  it("refuses no steps, too many steps and an empty apply line", () => {
    expect(pseudocodeProblem(measure, { ...sound(), steps: [] })).toMatch(/from 1 to/);
    const many = Array.from({ length: MAX_PSEUDOCODE_STEPS + 1 }, () => ({ kind: "det" as const, line: "x" }));
    expect(pseudocodeProblem(measure, { ...sound(), steps: many })).toMatch(/from 1 to/);
    expect(pseudocodeProblem(measure, { ...sound(), apply: " " })).toMatch(/apply must say/);
  });

  it("holds the steps to the leaf's kind", () => {
    const modelStep = { kind: "model" as const, line: "ask a model" };
    expect(pseudocodeProblem(measure, { ...sound(), steps: [modelStep] })).toMatch(/deterministic/);
    expect(pseudocodeProblem({ ...measure, kind: "model" }, sound())).toMatch(/needs a model/);
    expect(pseudocodeProblem({ ...measure, kind: "host" }, { ...sound(), steps: [{ kind: "det", line: "x" }] })).toMatch(/host/);
  });

  it("renders the input, numbered marked steps, the output and apply, within the line cap", () => {
    expect(renderPseudocode(sound()).split("\n")).toEqual([
      "input: { url: string }",
      "1. [host] fetch the url",
      "2. [det] compute score and issues",
      "output: { score: number, issues: string[] }",
      "apply: nothing",
    ]);
    const full = renderPseudocode({
      ...sound(),
      steps: Array.from({ length: MAX_PSEUDOCODE_STEPS }, () => ({ kind: "det" as const, line: "x\ny" })),
    });
    expect(full.split("\n")).toHaveLength(MAX_PSEUDOCODE_LINES);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Several sources, concurrency and failure
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities over several sources", () => {
  it("runs every source, and every sample of it, at the same time and keeps the runs apart, in the order given", async () => {
    let arrived = 0;
    let open!: () => void;
    const release = new Promise<void>((resolve) => (open = resolve));
    const respond = responder({ proposal: [leaf("shop.page.measure")] });
    const step: ModelStep = async (prompt) => {
      if (purposeOf(prompt) === "propose") {
        if (++arrived === 6) open();
        await release; // opens only once all six proposals wait: a serial run hangs until the test times out
      }
      return respond(prompt);
    };
    const output = await runProposeCapabilities(
      { sources: [SHOP, NOTES, { ...SHOP, ref: "~/Developer/other" }], phase: 1, samples: 2 },
      { step, machine: new FakeMachine() },
    );
    expect(output.runs.map((run) => [run.source, run.kind])).toEqual([
      ["~/Developer/shop", "folder"],
      ["claude:abc", "conversation"],
      ["~/Developer/other", "folder"],
    ]);
    expect(output.totals).toMatchObject({ sources: 3, kept: 3 });
  });

  it("never keeps more than 8 model calls in flight, however many sources and samples ask", async () => {
    let inFlight = 0;
    let peak = 0;
    const respond = responder({ proposal: [leaf("shop.page.measure")] });
    const step: ModelStep = async (prompt) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return respond(prompt);
    };
    const sources = Array.from({ length: 4 }, (_, index) => ({ ...SHOP, ref: `~/Developer/s${index}` }));
    const output = await runProposeCapabilities({ sources, phase: 1, samples: 5 }, { step, machine: new FakeMachine() });
    expect(output.runs).toHaveLength(4);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("aborts the model calls still running when one source fails, and fails with that error", async () => {
    let sawAbort = false;
    const step: ModelStep = async (prompt, signal) => {
      if (inputOf(prompt).includes("Source: ~/Developer/shop")) throw new Error("boom");
      await new Promise<void>((_, reject) =>
        signal!.addEventListener("abort", () => {
          sawAbort = true;
          reject(signal!.reason);
        })
      );
      return "";
    };
    await expect(
      runProposeCapabilities({ sources: [SHOP, NOTES], phase: 1, samples: 1 }, { step, machine: new FakeMachine() }),
    ).rejects.toThrow(/boom/);
    expect(sawAbort).toBe(true);
  });

  it("stops at the caller's abort signal", async () => {
    const controller = new AbortController();
    const step: ModelStep = async (_prompt, signal) => {
      controller.abort(new Error("caller stopped"));
      signal?.throwIfAborted();
      return "";
    };
    await expect(
      runProposeCapabilities({ sources: [SHOP], phase: 1 }, { step, machine: new FakeMachine(), signal: controller.signal }),
    ).rejects.toThrow(/caller stopped/);
  });

  it("reads source strings through the machine and the conversation reader, and reports progress", async () => {
    const machine = new FakeMachine({ "/work/notes.md": "# notes\nmeasure pages" });
    const progress: string[] = [];
    const world = proposeCapabilitiesWorld({ proposal: [leaf("shop.page.measure", { evidence: ["notes.md:2"] })] }, machine);
    const reads: string[] = [];
    const output = await world.run(
      { sources: ["notes.md", "claude:abc12345"], phase: 1, samples: 1 },
      {
        onProgress: (message) => progress.push(message),
        readConversation: async (harness, identifier) => {
          reads.push(`${harness}/${identifier}`);
          return [{ role: "user", text: "measure" }, { role: "tool", text: "", tool_call: { id: "1", name: "Bash", input: { command: "m" } } }];
        },
      },
    );
    expect(output.runs.map((run) => [run.source, run.kind])).toEqual([["notes.md", "file"], ["claude:abc12345", "conversation"]]);
    expect(reads).toEqual(["claude/abc12345"]);
    expect(progress.some((line) => line.startsWith("notes.md: proposing"))).toBe(true);
  });
});

describe("limitStep", () => {
  it("runs at most `limit` calls at once and answers every caller", async () => {
    let inFlight = 0;
    let peak = 0;
    const step = limitStep(async (prompt) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return prompt.toUpperCase();
    }, 3);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, index) => step(`p${index}`)));
    expect(replies).toEqual(Array.from({ length: 10 }, (_, index) => `P${index}`));
    expect(peak).toBe(3);
  });

  it("drops a call waiting for a slot when its signal aborts, and lets the next one through", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const step = limitStep(async (prompt) => {
      if (prompt === "first") await held;
      return prompt;
    }, 1);
    const first = step("first");
    const controller = new AbortController();
    const waiting = step("second", controller.signal);
    const third = step("third");
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow(/gave up/);
    release();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------

describe("propose_capabilities input", () => {
  it("refuses no sources, a namespace that is not one word, a phase and samples out of range", async () => {
    const world = proposeCapabilitiesWorld();
    await expect(world.run({ sources: [] })).rejects.toThrow(/sources must name at least one/);
    await expect(world.run({ sources: [SHOP], namespace: "web.master" })).rejects.toThrow(/namespace must be one lower-case word/);
    await expect(world.run({ sources: [SHOP], phase: 3 as never })).rejects.toThrow(/phase must be 1 or 2/);
    await expect(world.run({ sources: [SHOP], samples: 6 })).rejects.toThrow(/samples must be a whole number from 1 to 5/);
    await expect(world.run({ sources: [SHOP], min_agreement: 0 })).rejects.toThrow(/min_agreement must be a whole number from 1 to 5/);
    await expect(world.run({ sources: [SHOP], samples: 1.5 })).rejects.toThrow(/samples/);
    expect(world.prompts).toEqual([]);
  });

  it("reads null as omitted", () => {
    expect(
      optionsFrom({ sources: ["a"], namespace: null, phase: null, samples: null, min_agreement: null, registered: null } as never),
    ).toEqual({ sources: ["a"], phase: 2, samples: 3, minAgreement: 2 });
  });

  it("refuses a source object with a wrong shape, before any model call", async () => {
    const world = proposeCapabilitiesWorld();
    await expect(world.run({ sources: [{ ref: "x", kind: "page", body: "b", anchors: [], truncated: false } as never] })).rejects.toThrow(
      /sources\[0\]\.kind must be one of conversation, file, folder/,
    );
    await expect(world.run({ sources: [{ ...SHOP, body: "" }] })).rejects.toThrow(/sources\[0\]\.body must be a non-empty string/);
    expect(world.prompts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Checks without a model
// ---------------------------------------------------------------------------------------------------------------

describe("nameProblem", () => {
  it.each(["webmaster.page.seo", "psi_sweep", "photo.duplicate.find"])("accepts %s", (name) => {
    expect(nameProblem(name)).toBeUndefined();
  });

  it.each(["", ".", "a.", ".a", "a..b", "1a", "a.1b", "a b", "a-b", "A", "a.B", "_a"])("refuses the malformed shape %j", (name) => {
    expect(nameProblem(name)).toMatch(/lower-case snake_case/);
  });

  it.each([
    ["Webmaster.Page", /lower-case snake_case/],
    ["webmaster.page-seo", /lower-case snake_case/],
    ["webmaster..seo", /lower-case snake_case/],
    ["webmaster.page.with_llm", /says how.*"with"/],
    ["webmaster.host.via_ssh", /says how.*"via"/],
    ["page.seo_using_regex", /says how.*"using"/],
    ["a.b.c.d.e", /too long/],
    [`page.${"x".repeat(MAX_NAME_CHARS)}`, /too long/],
  ])("refuses %s with a reason for the model", (name, reason) => {
    expect(nameProblem(name)).toMatch(reason);
  });

  it("holds every name to the namespace when one is given", () => {
    expect(nameProblem("webmaster.page.seo", "webmaster")).toBeUndefined();
    expect(nameProblem("page.seo", "webmaster")).toMatch(/must start with "webmaster\."/);
    expect(nameProblem("webmasters.page", "webmaster")).toMatch(/must start with "webmaster\."/);
  });

  it("bans exactly the filler verbs", () => {
    expect([...BANNED_LAST_WORDS].sort()).toEqual(
      ["check", "do", "execute", "fetch", "get", "handle", "manage", "perform", "process", "run"].sort(),
    );
  });

  it.each([
    ["uptime.check", "check"],
    ["code.audit.run", "run"],
    ["search.run", "run"],
    ["page.fetch", "fetch"],
    ["site.get", "get"],
    ["mail.handle", "handle"],
    ["order.process", "process"],
    ["page.do", "do"],
    ["host.manage", "manage"],
    ["job.execute", "execute"],
    ["page.perform", "perform"],
    ["page.run_check", "check"],
  ])("refuses %s, whose last word is the filler verb %s, and says what to end in", (name, verb) => {
    expect(nameProblem(name)).toMatch(new RegExp(`ends in the filler verb "${verb}".*noun.*specific verb`));
  });

  it.each(["site.uptime", "page.source", "code.audit", "photo.duplicate.find", "mail.records.check_spf", "run.log"])(
    "accepts %s",
    (name) => {
      expect(nameProblem(name)).toBeUndefined();
    },
  );
});

describe("registeredSiblings and proposalProblem", () => {
  const registered = ["webmaster.page.seo", "webmaster.sitemap", "webmasters.other", "plan_tasks", "shop.page.measure"];

  it("lists the registered names that start with the namespace and a dot", () => {
    expect(registeredSiblings(registered, "webmaster")).toEqual(["webmaster.page.seo", "webmaster.sitemap"]);
  });

  it("lists none without a namespace, or for a namespace nothing is registered under", () => {
    expect(registeredSiblings(registered, undefined)).toEqual([]);
    expect(registeredSiblings(registered, "photo")).toEqual([]);
  });

  it("refuses a name that is already registered, naming it", () => {
    expect(proposalProblem([leaf("shop.page.measure")], SHOP, "shop", ["shop.page.measure"])).toMatch(
      /"shop.page.measure" is already a registered capability.*propose only what is missing/,
    );
  });

  it("accepts a name no sibling has, and refuses a filler verb before anything else about the name", () => {
    expect(proposalProblem([leaf("shop.page.measure")], SHOP, "shop", ["shop.brand.conform"])).toBeUndefined();
    expect(proposalProblem([leaf("shop.page.check")], SHOP, "shop")).toMatch(/ends in the filler verb "check"/);
  });
});

describe("agreement", () => {
  const concept = (name: string, samples: number[], proposedAs: string[] = []): AgreedLeaf => ({
    ...leaf(name),
    agreement: new Set(samples).size,
    members: samples.map((sample, at) => ({ sample, name: proposedAs[at] ?? name })),
  });

  it("is the minimum asked for, never more than the samples there are", () => {
    expect(requiredAgreement(2, 3)).toBe(2);
    expect(requiredAgreement(2, 1)).toBe(1);
    expect(requiredAgreement(5, 3)).toBe(3);
  });

  it("counts the different samples, not the members", () => {
    expect(agreementOf([{ sample: 1, name: "a" }, { sample: 1, name: "b" }, { sample: 3, name: "c" }])).toBe(2);
  });

  it("keeps a concept two of three samples proposed and rejects one a single sample proposed, by its canonical name", () => {
    const { kept, rejected } = partitionByAgreement(
      [concept("a.one", [1, 2, 3]), concept("a.two", [2]), concept("a.three", [1, 3])],
      2,
      3,
    );
    expect(kept.map((each) => [each.name, each.agreement])).toEqual([["a.one", 3], ["a.three", 2]]);
    expect(rejected).toEqual([{
      name: "a.two",
      objection: "proposed by 1 of 3 samples",
      failed_criteria: [],
      agreement: 1,
      members: [{ sample: 2, name: "a.two" }],
    }]);
  });

  it("reports the members a kept concept folded in under another name as merged into it", () => {
    expect(partitionByAgreement([concept("a.one", [1, 2, 3], ["a.one", "a.uno", "a.uno"])], 2, 3).merged).toEqual([
      { name: "a.uno", into: "a.one" },
    ]);
  });

  it("asks for the agreement it is given", () => {
    const clusters = [concept("a.one", [1, 2, 3]), concept("a.two", [1, 2])];
    expect(partitionByAgreement(clusters, 3, 3).kept.map((each) => each.name)).toEqual(["a.one"]);
    expect(partitionByAgreement(clusters, 3, 3).rejected[0]!.objection).toBe("proposed by 2 of 3 samples");
    expect(partitionByAgreement(clusters, 1, 3).rejected).toEqual([]);
  });
});

describe("clustersFrom", () => {
  const FRAME = { namespace: undefined, siblings: [] as string[], samples: 3 };
  const samples = [
    [leaf("shop.page.measure"), leaf("shop.brand.conform")],
    [leaf("shop.page.measure_score", { input_fields: ["url", "strategy"] })],
    [leaf("shop.page.measure")],
  ];
  const cluster = (name: string, memberList: { sample: number; name: string }[], extra: object = {}) => ({
    name,
    purpose: `Does ${name}.`,
    kind: "deterministic" as const,
    input_fields: ["url"],
    output_fields: ["score"],
    evidence: ["src/measure.ts:3"],
    members: memberList,
    ...extra,
  });
  const everyProposal = [
    cluster("shop.page.measure", [
      { sample: 1, name: "shop.page.measure" },
      { sample: 2, name: "shop.page.measure_score" },
      { sample: 3, name: "shop.page.measure" },
    ]),
    cluster("shop.brand.conform", [{ sample: 1, name: "shop.brand.conform" }]),
  ];

  it("groups the proposals of different samples under one canonical name and counts the samples", () => {
    const clusters = clustersFrom(everyProposal, samples, SHOP, FRAME);
    expect(clusters.map((each) => [each.name, each.agreement])).toEqual([["shop.page.measure", 3], ["shop.brand.conform", 1]]);
  });

  it("draws the reason and summaries from the fullest member", () => {
    const [first] = clustersFrom(everyProposal, samples, SHOP, FRAME);
    expect(first!.reason).toBe("Someone runs shop.page.measure_score on demand.");
    expect(first!.input_summary).toBe("input of shop.page.measure_score");
  });

  it("counts a member listed twice once", () => {
    const [first] = clustersFrom(
      [cluster("shop.page.measure", [{ sample: 1, name: "shop.page.measure" }, { sample: 1, name: "shop.page.measure" }])],
      [[leaf("shop.page.measure")]],
      SHOP,
      { ...FRAME, samples: 1 },
    );
    expect(first!.agreement).toBe(1);
  });

  it("lets a proposal that joins two jobs be split into two clusters of the same member", () => {
    const clusters = clustersFrom(
      [
        cluster("shop.page.measure", [{ sample: 1, name: "shop.page.measure" }]),
        cluster("shop.page.score", [{ sample: 1, name: "shop.page.measure" }]),
      ],
      [[leaf("shop.page.measure")]],
      SHOP,
      { ...FRAME, samples: 1 },
    );
    expect(clusters.map((each) => each.name)).toEqual(["shop.page.measure", "shop.page.score"]);
  });

  it("refuses a member the named sample did not propose, so none can be invented", () => {
    const invented = [cluster("shop.page.measure", [{ sample: 2, name: "shop.page.measure" }]), ...everyProposal];
    expect(() => clustersFrom(invented, samples, SHOP, FRAME)).toThrow(/lists "shop.page.measure" as sample 2's proposal, which it is not/);
    expect(() => clustersFrom([cluster("shop.page.measure", [{ sample: 9, name: "shop.page.measure" }])], samples, SHOP, FRAME)).toThrow(/sample 9/);
  });

  it("refuses a reply that leaves a proposal in no cluster", () => {
    expect(() => clustersFrom(everyProposal.slice(0, 1), samples, SHOP, FRAME)).toThrow(
      /1 proposals are in no cluster \(sample 1 shop.brand.conform\)/,
    );
  });

  it("holds each canonical name to the name rules, the registered names and the evidence", () => {
    const filler = [{ ...everyProposal[0]!, name: "shop.page.check" }, everyProposal[1]!];
    expect(() => clustersFrom(filler, samples, SHOP, FRAME)).toThrow(/ends in the filler verb "check"/);
    const how = [{ ...everyProposal[0]!, name: "shop.page.measure_with_llm" }, everyProposal[1]!];
    expect(() => clustersFrom(how, samples, SHOP, FRAME)).toThrow(/says how/);
    expect(() => clustersFrom(everyProposal, samples, SHOP, { ...FRAME, namespace: "webmaster" })).toThrow(/must start with "webmaster\."/);
    expect(() => clustersFrom(everyProposal, samples, SHOP, { ...FRAME, siblings: ["shop.brand.conform"] })).toThrow(/already a registered capability/);
    const twice = [everyProposal[0]!, { ...everyProposal[1]!, name: "shop.page.measure" }];
    expect(() => clustersFrom(twice, samples, SHOP, FRAME)).toThrow(/listed twice/);
    const wrong = [{ ...everyProposal[0]!, evidence: ["src/nowhere.ts:1"] }, everyProposal[1]!];
    expect(() => clustersFrom(wrong, samples, SHOP, FRAME)).toThrow(/cites "src\/nowhere.ts:1"/);
  });

  it("makes each proposal of a lone sample a concept of its own with agreement 1", () => {
    expect(singleSampleClusters([leaf("shop.page.measure")])[0]).toMatchObject({
      agreement: 1,
      members: [{ sample: 1, name: "shop.page.measure" }],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------------------------

describe("the tool", () => {
  const result = (stdout: string, code = 0) => ({ stdout, stderr: "", code, killed: false });

  function pi(exec: Exec, cwd: string) {
    // The load check against omp's own zod lives outside the suite; here a tiny builder records the schema shape.
    const schema = (kind: string) => {
      const node: Record<string, unknown> = { kind };
      const chain: unknown = new Proxy(node, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
      return chain;
    };
    const zod = new Proxy({}, { get: (_t, kind) => (..._a: unknown[]) => schema(String(kind)) });
    return { zod, exec, cwd, logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings and what it will not do", () => {
    const tool = factory(pi(async () => result(""), "/") ) as { name: string; description: string };
    expect(tool.name).toBe("propose_capabilities");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const mention of ["identify_goals", "get_recent_turns", "omp -p", "MUST", "proposes only"]) {
      expect(tool.description).toContain(mention);
    }
  });

  it("runs a file through execute with a fake omp, reading only what it names", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "propose-"));
    try {
      await writeFile(join(directory, "notes.md"), "# notes\nmeasure every page\n");
      const respond = responder({ proposal: [leaf("shop.page.measure", { evidence: ["notes.md:2"] })] });
      const calls: string[] = [];
      const exec: Exec = async (command, args) => {
        calls.push(command);
        return result(respond(await readFile(args[1]!.slice(1), "utf8")));
      };
      const tool = factory(pi(exec, directory)) as unknown as {
        execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{
          content: { text: string }[];
          details: ProposeCapabilitiesOutput;
        }>;
      };
      const done = await tool.execute(
        "t1",
        { sources: ["notes.md"], namespace: null, phase: 2, samples: 2, min_agreement: null, registered: null },
        undefined,
        undefined,
      );
      expect(JSON.parse(done.content[0]!.text)).toEqual(JSON.parse(JSON.stringify(done.details)));
      expect(done.details.runs[0]).toMatchObject({ source: "notes.md", kind: "file", samples: 2 });
      expect(names(done.details.runs[0]!.capabilities)).toEqual(["shop.page.measure"]);
      expect(done.details.runs[0]!.capabilities[0]!.pseudocode).toContain("[det] compute shop.page.measure");
      expect(calls.every((command) => command === "omp")).toBe(true);
      expect(done.details.totals.calls).toEqual({ propose: 2, reconcile: 1, confirm: 1, pseudocode: 1 });
      await expect(tool.execute("t2", { sources: [] }, undefined, undefined)).rejects.toThrow(/at least one/);
      await expect(tool.execute("t3", { sources: ["missing.md"] }, undefined, undefined)).rejects.toThrow(/cannot read .*missing\.md/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
