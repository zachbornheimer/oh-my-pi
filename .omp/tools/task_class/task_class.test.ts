import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CATEGORIES, EXAMPLES, THRESHOLD } from "./categories.js";
import {
  classificationPrompt,
  NO_WORDS_MESSAGE,
  parsePick,
  promptText,
  runTaskClass,
  settle,
  TASK_CLASSES,
} from "./classify.js";
import factory from "./index.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep, ompModelStep } from "./omp_model.js";

const reply = (classification: string, confidence: number | string): string => JSON.stringify({ classification, confidence });

/** A fake model that answers each request with the next reply and records the requests. */
function fakeModel(...replies: (string | Error)[]) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const next = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { step, prompts };
}

describe("the question (agentmux task_class.yaml, copied)", () => {
  it("has the seven categories in order, the 0.7 threshold and the 15 worked examples", () => {
    expect(CATEGORIES.map((category) => category.id)).toEqual([...TASK_CLASSES]);
    expect(THRESHOLD).toBe(0.7);
    expect(EXAMPLES).toHaveLength(15);
    expect(EXAMPLES[0]).toEqual({
      text: "Create a file named hello.txt containing the single line: hello from delegate. Commit it.",
      category: "simple_edit",
    });
    expect(EXAMPLES.at(-1)).toEqual({ text: "Report what changed since the last release.", category: "status_update" });
  });

  it("puts the question, every category, every example and the fenced goal in one request", () => {
    const prompt = classificationPrompt("fix a typo");
    expect(prompt).toContain("What kind of work is this goal?");
    for (const category of CATEGORIES) expect(prompt).toContain(`- ${category.id}: ${category.criteria}`);
    for (const example of EXAMPLES) expect(prompt).toContain(`${JSON.stringify(example.text)} -> ${example.category}`);
    expect(prompt).toContain("<<<\nfix a typo\n>>>");
    expect(prompt).toContain('"classification": "simple_edit | hard_code');
  });
});

describe("settle (agentmux's U3 cases: threshold 0.7 and the closed vocabulary)", () => {
  it.each([
    ["simple_edit", 0.9, { value: "simple_edit", certain: true, evidence: "simple_edit" }],
    ["simple_edit", 0.7, { value: "simple_edit", certain: true, evidence: "simple_edit" }],
    ["simple_edit", 0.69, { value: "hard_code", certain: false, evidence: "simple_edit" }],
    ["research", 0.95, { value: "research", certain: true, evidence: "research" }],
    ["not_a_class", 0.99, { value: "hard_code", certain: false, evidence: "not_a_class" }],
  ] as const)("%s at %d", (classification, confidence, expected) => {
    expect(settle({ classification, confidence })).toEqual(expected);
  });
});

describe("parsePick", () => {
  it("accepts a pick and trims the category", () => {
    expect(parsePick({ classification: " research ", confidence: 0.5 })).toEqual({ classification: "research", confidence: 0.5 });
  });

  it.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{ confidence: 0.9 }, /classification must be/],
    [{ classification: "", confidence: 0.9 }, /classification must be/],
    [{ classification: "research" }, /confidence must be/],
    [{ classification: "research", confidence: "0.9" }, /confidence must be/],
    [{ classification: "research", confidence: 1.5 }, /confidence must be/],
    [{ classification: "research", confidence: -0.1 }, /confidence must be/],
  ])("refuses %j", (value, message) => {
    expect(() => parsePick(value)).toThrow(message);
  });
});

describe("runTaskClass", () => {
  it("asks one model run and settles its pick", async () => {
    const model = fakeModel(reply("simple_edit", 0.9));
    expect(await runTaskClass("  Fix the typo in the README title and commit. \n", { step: model.step })).toEqual({
      value: "simple_edit",
      certain: true,
      evidence: "simple_edit",
    });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("<<<\nFix the typo in the README title and commit.\n>>>");
  });

  it("falls back to hard_code, uncertain, below the threshold or off the vocabulary, keeping what the model picked", async () => {
    expect(await runTaskClass("x", { step: fakeModel(reply("research", 0.4)).step })).toEqual({
      value: "hard_code",
      certain: false,
      evidence: "research",
    });
    expect(await runTaskClass("x", { step: fakeModel(reply("bug_fix", 0.99)).step })).toEqual({
      value: "hard_code",
      certain: false,
      evidence: "bug_fix",
    });
  });

  it("refuses blank or non-string words before any model call", async () => {
    const model = fakeModel(reply("research", 1));
    for (const text of ["", "  \n\t", undefined, 7]) {
      await expect(runTaskClass(text, { step: model.step })).rejects.toThrow(NO_WORDS_MESSAGE);
    }
    expect(model.prompts).toHaveLength(0);
    expect(promptText("\u00a0 hi \u2003")).toBe("hi");
  });

  it("asks again with the reason when the reply is not a valid pick, then succeeds", async () => {
    const model = fakeModel("I think it is research.", reply("research", "high"), reply("research", 0.8));
    expect(await runTaskClass("find out why", { step: model.step })).toEqual({ value: "research", certain: true, evidence: "research" });
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[1]).toContain("the reply is not JSON");
    expect(model.prompts[2]).toContain("confidence must be a number from 0 to 1");
  });

  it("fails `classify task: <cause>` after three bad replies and never invents a class", async () => {
    const model = fakeModel("nope");
    await expect(runTaskClass("x", { step: model.step })).rejects.toThrow(/^classify task: no valid reply after 3 attempts: the reply is not JSON/);
    expect(model.prompts).toHaveLength(3);
  });

  it("fails `classify task: <cause>` when the model run fails, keeping the cause", async () => {
    const model = fakeModel(new Error("model step exited 2: unavailable"));
    await expect(runTaskClass("x", { step: model.step })).rejects.toThrow("classify task: model step exited 2: unavailable");
  });

  it("propagates cancellation without wrapping it", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort();
      throw new Error("cancelled");
    };
    await expect(runTaskClass("x", { step, signal: controller.signal })).rejects.not.toThrow(/classify task/);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }
  const noExec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(noExec)) as { name: string; description: string };
    expect(tool.name).toBe("task_class");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["classify_prompt_parts", "identify_intent", "select_model"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp, a private prompt file removed afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], text: await readFile(args[1]!.slice(1), "utf8"), cwd: options?.cwd };
      return { stdout: reply("summarization", 0.85), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: { text: string }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
    };
    const result = await tool.execute("id", { text: "Summarize this incident report." }, undefined, undefined, undefined);
    expect(result.details).toEqual({ value: "summarization", certain: true, evidence: "summarization" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toContain("Summarize this incident report.");
    expect(existsSync(seen!.cwd!)).toBe(false);
  });

  it("fails the call, not a success, when omp exits non-zero", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "no key", code: 1, killed: false });
    const tool = factory(pi(exec)) as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    await expect(tool.execute("id", { text: "x" }, undefined, undefined, undefined)).rejects.toThrow(/classify task: model step exited 1: no key/);
  });

  it("builds a real model step that reads the reply from stdout", async () => {
    const exec: Exec = async () => ({ stdout: ` ${reply("research", 0.9)} \n`, stderr: "", code: 0, killed: false });
    expect(await ompModelStep(exec)("p")).toBe(reply("research", 0.9));
  });
});
