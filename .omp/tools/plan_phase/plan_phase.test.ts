import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { classificationPrompt, parsePick, settle } from "./classify.js";
import factory from "./index.js";
import { type Exec, type ModelStep } from "./omp_model.js";
import { NO_WORDS_MESSAGE, PHASE_CLASSIFICATION, PLAN_PHASES, runPlanPhase } from "./plan_phase.js";

const reply = (choice: string, probability: number): string => JSON.stringify({ classification: choice, probability });
const scripted = (...replies: (string | Error)[]) => {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const next = replies[Math.min(prompts.length, replies.length) - 1]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { step, prompts };
};

describe("plan_phase settling (Mastra classifier cases U1-U6)", () => {
  it("U1: a confident pick on the menu is certain", async () => {
    const model = scripted(reply("edge", 0.95));
    expect(await runPlanPhase("add a table test covering the empty name", { step: model.step })).toEqual({
      value: "edge",
      certain: true,
      evidence: "edge",
    });
  });

  it("U2: an unsure pick falls back to happy_path and keeps the pick as evidence", async () => {
    const model = scripted(reply("edge", 0.1));
    expect(await runPlanPhase("not sure what this is", { step: model.step })).toEqual({
      value: "happy_path",
      certain: false,
      evidence: "edge",
    });
  });

  it("U3: the menu teaches that the request decides validation", () => {
    expect(PHASE_CLASSIFICATION.question).toContain("request");
    const happy = PHASE_CLASSIFICATION.examples.find((example) => example.category === "happy_path" && /alidat/.test(example.text));
    expect(happy).toBeDefined();
  });

  it("U4: a pick off the menu is unsure (settle, the rule reply validation otherwise prevents)", () => {
    expect(settle(PHASE_CLASSIFICATION, { choice: "not_a_real_phase", probability: 0.99 }, PLAN_PHASES, "happy_path")).toEqual({
      value: "happy_path",
      certain: false,
      evidence: "not_a_real_phase",
    });
  });

  it("U5: the threshold is 0.6 inclusive", async () => {
    const text = "Split the 300-line handler into named steps now that it works";
    const cases: [string, number, string, boolean][] = [
      ["structural", 0.6, "structural", true],
      ["structural", 0.59, "happy_path", false],
      ["production", 0.9, "production", true],
    ];
    for (const [choice, probability, value, certain] of cases) {
      const result = await runPlanPhase(text, { step: scripted(reply(choice, probability)).step });
      expect([result.value, result.certain, result.evidence]).toEqual([value, certain, choice]);
    }
  });

  it("U6: a failing model step reads `classify phase: <cause>` and invents no phase", async () => {
    const model = scripted(new Error("unavailable"));
    await expect(runPlanPhase("x", { step: model.step })).rejects.toThrow("classify phase: unavailable");
  });
});

describe("plan_phase input and model step", () => {
  it("refuses blank text and non-strings without calling the model", async () => {
    const model = scripted(reply("edge", 1));
    await expect(runPlanPhase("  \n ", { step: model.step })).rejects.toThrow(NO_WORDS_MESSAGE);
    await expect(runPlanPhase(undefined, { step: model.step })).rejects.toThrow(NO_WORDS_MESSAGE);
    expect(model.prompts).toHaveLength(0);
  });

  it("asks again with the reason when the reply is off the menu or has a bad probability, then fails after 3 tries", async () => {
    const model = scripted(reply("nonsense", 0.9), JSON.stringify({ classification: "edge", probability: 7 }), reply("edge", 0.8));
    const result = await runPlanPhase("harden it", { step: model.step });
    expect(result).toEqual({ value: "edge", certain: true, evidence: "edge" });
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[1]).toContain("classification must be one of happy_path, structural, edge, production");
    expect(model.prompts[2]).toContain("probability must be a number from 0 to 1, got 7");

    const bad = scripted("not json at all");
    await expect(runPlanPhase("harden it", { step: bad.step })).rejects.toThrow(/classify phase: no valid reply after 3 attempts: the reply is not JSON/);
    expect(bad.prompts).toHaveLength(3);
  });

  it("accepts a JSON reply wrapped in one code fence", async () => {
    const result = await runPlanPhase("harden it", { step: scripted("```json\n" + reply("production", 0.7) + "\n```").step });
    expect(result.value).toBe("production");
  });

  it("quotes the step as data after the menu and examples", async () => {
    const model = scripted(reply("edge", 0.9));
    await runPlanPhase("Add a table test (request: greet users)", { step: model.step });
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("- happy_path: The smallest slice");
    expect(prompt).toContain('Text: "Add a table test covering the empty name case"\nAnswer: edge');
    expect(prompt).toContain("<<<\nAdd a table test (request: greet users)\n>>>");
    expect(prompt.indexOf("Worked examples")).toBeLessThan(prompt.indexOf("<<<"));
    expect(prompt.endsWith('"probability": <your probability from 0 to 1 that this option is the right one>}')).toBe(true);
    expect(classificationPrompt(PHASE_CLASSIFICATION, "x")).toContain('"classification": "happy_path | structural | edge | production"');
  });

  it("does not hide an abort behind the classify wrapper", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const step: ModelStep = async () => {
      throw new Error("model step was killed");
    };
    await expect(runPlanPhase("x", { step, signal: controller.signal })).rejects.toThrow("stop");
  });

  it("parsePick rejects non-objects", () => {
    expect(() => parsePick(PHASE_CLASSIFICATION, [])).toThrow(/JSON object/);
    expect(() => parsePick(PHASE_CLASSIFICATION, "edge")).toThrow(/JSON object/);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }
  const idle: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(idle)) as { name: string; description: string };
    expect(tool.name).toBe("plan_phase");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["plan_tasks", "identify_goals"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp and returns details", async () => {
    const exec: Exec = async (command, args) => {
      if (command !== "omp") throw new Error(`unexpected ${command}`);
      expect(await readFile(args[1]!.slice(1), "utf8")).toContain("<<<\nAdd a greeting\n>>>");
      return { stdout: reply("happy_path", 0.9), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: { text: string }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
    };
    const result = await tool.execute("t1", { text: " Add a greeting " }, undefined, undefined);
    expect(result.details).toEqual({ value: "happy_path", certain: true, evidence: "happy_path" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    await expect(tool.execute("t2", { text: " " }, undefined, undefined)).rejects.toThrow(NO_WORDS_MESSAGE);
  });
});
