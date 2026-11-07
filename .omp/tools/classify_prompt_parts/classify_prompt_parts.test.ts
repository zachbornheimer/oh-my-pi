import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  aggregateRequirements,
  fallbackReason,
  noSignals,
  readStrength,
  runClassifyPromptParts,
  scorePrompt,
  SIGNAL_FIELDS,
  splitPrompt,
  weakestStrength,
} from "./classify.js";
import { parseDecisions } from "./decide.js";
import factory from "./index.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep } from "./omp_model.js";
import { STRENGTH_QUESTIONS } from "./questions.js";
import { locatePieces, NO_WORDS_MESSAGE, wholePrompt } from "./segment.js";

const PROMPT = "Research the cache. Fix the bug.";
const PIECES = ["Research the cache.", "Fix the bug."];

/** Every question answered; overridable per part. */
const ANSWERS = {
  ModelStrength: 1,
  SoftwareImplementation: false,
  SoftwareArchitecture: false,
  DifficultDebugging: false,
  Research: true,
  Ambiguity: false,
  LongHorizon: false,
};

/** A fake model: a split request gets `pieces`, a score request gets ANSWERS merged with `answer(partText)`. */
function fakeModel(options: { pieces?: unknown[]; answer?: (part: string) => Record<string, unknown> | string | Error } = {}) {
  const prompts: string[] = [];
  let splits = 0;
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("## Pieces")) {
      const reply = options.pieces?.[Math.min(splits, options.pieces.length - 1)] ?? PIECES;
      splits += 1;
      return typeof reply === "string" ? reply : JSON.stringify({ Pieces: reply });
    }
    const part = /Answer about this segment only:\n([\s\S]*?)(\n\nThe whole input|\n\nReply with only)/.exec(prompt)![1]!;
    const answer = options.answer?.(part);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") return answer;
    return JSON.stringify({ ...ANSWERS, ...answer });
  };
  return { step, prompts, scores: () => prompts.filter((prompt) => !prompt.startsWith("## Pieces")) };
}

const run = (text: unknown, model: { step: ModelStep }) => runClassifyPromptParts(text, { step: model.step });

describe("classify_prompt_parts", () => {
  it("splits once, scores each part with strength and the six signals, never an intent question", async () => {
    const model = fakeModel();
    const result = await run(PROMPT, model);
    expect(result.Prompt.Content).toBe(PROMPT);
    expect(result.Prompt.Parts.map((part) => part.Content)).toEqual(PIECES);
    expect(result.Prompt.Parts.map((part) => part.Span)).toEqual([{ Start: 0, End: 19 }, { Start: 20, End: 32 }]);
    for (const part of result.Prompt.Parts) expect(part.ID).toMatch(/^prt_[0-9a-f]{32}$/);
    expect(result.Prompt.Parts[0]).toMatchObject({
      ModelStrength: { Point: 1, Value: "reasoning" },
      Research: true,
      SoftwareImplementation: false,
    });
    expect(result.Requirements).toEqual({
      Strength: "reasoning",
      Signals: { ...noSignals(), Research: true },
    });
    expect(result.Degraded).toBe(false);
    expect(result.Reasons).toEqual([]);
    expect(model.prompts.filter((prompt) => prompt.startsWith("## Pieces"))).toHaveLength(1);
    expect(model.scores()).toHaveLength(2);
    for (const prompt of model.scores()) {
      for (const field of ["ModelStrength", ...SIGNAL_FIELDS]) expect(prompt).toContain(`## ${field}`);
      for (const intent of ["## Intent", "## Type", "## Atomic"]) expect(prompt).not.toContain(intent);
    }
  });

  it("shows each part with the whole prompt as context only", async () => {
    const model = fakeModel();
    await run(PROMPT, model);
    const [first, second] = model.scores();
    expect(first).toContain("Answer about this segment only:\nResearch the cache.");
    expect(first).toContain(`The whole input, for context only (do not answer about other segments):\n${PROMPT}`);
    expect(second).toContain("Answer about this segment only:\nFix the bug.");
  });

  it("takes the deepest strength and any signal over the parts (one hard part is never averaged away)", async () => {
    const model = fakeModel({
      answer: (part) => (part.startsWith("Fix") ? { ModelStrength: 2, DifficultDebugging: true, Research: false } : { ModelStrength: 0 }),
    });
    const result = await run(PROMPT, model);
    expect(result.Requirements.Strength).toBe("deep");
    expect(result.Requirements.Signals).toEqual({ ...noSignals(), DifficultDebugging: true, Research: true });
    expect(result.Prompt.Parts.map((part) => part.ModelStrength.Value)).toEqual(["routine", "deep"]);
  });

  it("falls back to deep with no signals and a reason per part when the model is down", async () => {
    const model = fakeModel({ answer: () => new Error("down") });
    const result = await run(PROMPT, model);
    expect(result.Degraded).toBe(true);
    expect(result.Requirements.Strength).toBe("deep");
    expect(result.Reasons).toHaveLength(2);
    const [first] = result.Prompt.Parts;
    expect(result.Reasons[0]).toContain(`classify_prompt_parts: part ${first!.ID} fell back to a conservative value: `);
    expect(result.Reasons[0]).toContain("down");
    for (const part of result.Prompt.Parts) {
      expect(part.ModelStrength).toEqual({ Point: 2, Value: "deep" });
      for (const field of SIGNAL_FIELDS) expect(part[field]).toBe(false);
    }
  });

  it("degrades only the part whose answer is off the scale, after asking again with the reason", async () => {
    const model = fakeModel({ answer: (part) => (part.startsWith("Fix") ? { ModelStrength: 7 } : {}) });
    const result = await run(PROMPT, model);
    expect(result.Reasons).toHaveLength(1);
    expect(result.Reasons[0]).toContain("ModelStrength must be an integer level from 0 to 2");
    expect(result.Prompt.Parts[0]!.ModelStrength.Point).toBe(1);
    expect(result.Prompt.Parts[0]!.Research).toBe(true);
    expect(result.Prompt.Parts[1]!.ModelStrength.Point).toBe(2);
    expect(result.Prompt.Parts[1]!.Research).toBe(false);
    // three attempts for the bad part, one for the good one
    expect(model.scores()).toHaveLength(4);
  });

  it("recovers a part whose first reply is prose", async () => {
    let calls = 0;
    const model = fakeModel({ answer: (part) => (part.startsWith("Fix") && (calls += 1) === 1 ? "hard to say" : {}) });
    const result = await run(PROMPT, model);
    expect(result.Degraded).toBe(false);
    expect(model.scores().some((prompt) => prompt.includes("Previous reply:\nhard to say"))).toBe(true);
  });

  it("treats the whole prompt as one part when the split fails, and says so", async () => {
    const model = fakeModel({ pieces: ["not json at all", ["nope"]] });
    const result = await run("Naïve cache. Fix it.", model);
    expect(model.prompts.filter((prompt) => prompt.startsWith("## Pieces"))).toHaveLength(3);
    expect(result.Degraded).toBe(true);
    expect(result.Reasons).toHaveLength(1);
    expect(result.Reasons[0]).toContain("the split fell back to the whole prompt as one part");
    expect(result.Reasons[0]).toContain("no valid reply after 3 attempts");
    expect(result.Prompt.Parts).toHaveLength(1);
    expect(result.Prompt.Parts[0]).toMatchObject({ Content: "Naïve cache. Fix it.", Span: { Start: 0, End: 21 } });
    expect(model.scores()).toHaveLength(1);
  });

  it("asks the split again with the reason when a piece is not the prompt's words", async () => {
    const model = fakeModel({ pieces: [["Research the cash.", "Fix the bug."], PIECES] });
    const result = await run(PROMPT, model);
    expect(result.Degraded).toBe(false);
    expect(result.Prompt.Parts.map((part) => part.Content)).toEqual(PIECES);
    expect(model.prompts.filter((prompt) => prompt.startsWith("## Pieces"))[1]).toContain("is not the prompt's next words");
  });

  it.each(["", "   ", "\n\t ", undefined, 3])("rejects blank or non-string words %j before any model call", async (text) => {
    const model = fakeModel();
    await expect(run(text, model)).rejects.toThrow(NO_WORDS_MESSAGE);
    expect(model.prompts).toHaveLength(0);
  });

  it("throws, rather than degrading, on cancellation", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort();
      throw new Error("cancelled");
    };
    await expect(runClassifyPromptParts(PROMPT, { step, signal: controller.signal })).rejects.toThrow();
  });

  it("scores at most `concurrency` parts at once", async () => {
    const parts = ["One.", "Two.", "Three.", "Four.", "Five."];
    let active = 0;
    let peak = 0;
    const step: ModelStep = async (prompt) => {
      if (prompt.startsWith("## Pieces")) return JSON.stringify({ Pieces: parts });
      active += 1;
      peak = Math.max(peak, active);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      active -= 1;
      return JSON.stringify(ANSWERS);
    };
    const result = await runClassifyPromptParts(parts.join(" "), { step, concurrency: 2 });
    expect(result.Prompt.Parts).toHaveLength(5);
    expect(peak).toBe(2);
  });
});

describe("pure parts (agentmux's aggregate and read-strength cases)", () => {
  const strength = (point: number, research: boolean) => ({
    ...noSignals(),
    Research: research,
    ModelStrength: { Point: point, Value: ["routine", "reasoning", "deep"][point]! },
  });

  it("aggregates the deepest strength and the signals' maximum", () => {
    expect(aggregateRequirements([strength(0, false), strength(2, true)])).toEqual({
      Strength: "deep",
      Signals: { ...noSignals(), Research: true },
    });
    expect(aggregateRequirements([strength(0, false)]).Strength).toBe("routine");
  });

  it("reads strength from settled answers and refuses an unanswered strength or signal", () => {
    const answers = parseDecisions(STRENGTH_QUESTIONS, { ...ANSWERS, ModelStrength: 2, Ambiguity: true });
    expect(readStrength(answers)).toMatchObject({ ModelStrength: { Point: 2, Value: "deep" }, Ambiguity: true, Research: true });
    expect(() => readStrength({})).toThrow(/ModelStrength was not answered/);
    expect(() => readStrength({ ModelStrength: { Point: 1, Value: "reasoning" } })).toThrow(/SoftwareImplementation was not answered/);
  });

  it("claims the deepest level and no signals for a part it could not score", () => {
    expect(weakestStrength()).toEqual({ ModelStrength: { Point: 2, Value: "deep" }, ...noSignals() });
    expect(fallbackReason("p1", new Error("boom"))).toBe("classify_prompt_parts: part p1 fell back to a conservative value: boom");
    expect(fallbackReason("p1", "text")).toContain("text");
  });

  it("places the whole prompt as one part with a byte span", () => {
    expect(wholePrompt("héllo")).toMatchObject({ Content: "héllo", Span: { Start: 0, End: 6 } });
    expect(locatePieces("a b", ["a", "b"]).map((part) => part.Span)).toEqual([{ Start: 0, End: 1 }, { Start: 2, End: 3 }]);
    expect(() => locatePieces("a b", ["a"])).toThrow(/uncovered/);
  });

  it("fences the words as data in the split request and states the part in the score request", () => {
    expect(splitPrompt("hello")).toContain("<<<\nhello\n>>>");
    const [part] = locatePieces("Fix it.", ["Fix it."]);
    expect(scorePrompt("Fix it.", part!)).toContain("Answer about this segment only:\nFix it.");
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as { name: string; description: string };
    expect(tool.name).toBe("classify_prompt_parts");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["identify_intent", "task_class", "select_model"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp: one prompt file per run, each removed afterwards", async () => {
    const seen: { args: string[]; text: string; cwd?: string }[] = [];
    const exec: Exec = async (command, args, options) => {
      const text = await readFile(args[1]!.slice(1), "utf8");
      seen.push({ args: [command, ...args], text, cwd: options?.cwd });
      const stdout = text.startsWith("## Pieces") ? JSON.stringify({ Pieces: ["Fix it."] }) : JSON.stringify({ ...ANSWERS, ModelStrength: 0 });
      return { stdout, stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: { text: string }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { Requirements: { Strength: string } } }>;
    };
    const result = await tool.execute("id", { text: "Fix it." }, undefined, undefined, undefined);
    expect(result.details.Requirements.Strength).toBe("routine");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.args.slice(0, 2)).toEqual(["omp", "-p"]);
      expect(call.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
      expect(existsSync(call.cwd!)).toBe(false);
    }
  });

  it("degrades, not fails, when every omp run exits non-zero", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "no key", code: 1, killed: false });
    const tool = factory(pi(exec)) as unknown as { execute: (...args: unknown[]) => Promise<{ details: { Degraded: boolean; Reasons: string[]; Requirements: { Strength: string } } }> };
    const result = await tool.execute("id", { text: "x" }, undefined, undefined, undefined);
    expect(result.details.Degraded).toBe(true);
    expect(result.details.Requirements.Strength).toBe("deep");
    expect(result.details.Reasons).toHaveLength(2);
    expect(result.details.Reasons.join("\n")).toContain("model step exited 1: no key");
  });
});
