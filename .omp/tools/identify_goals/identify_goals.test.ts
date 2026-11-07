import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { decisionPrompt, parseDecisions } from "./decide.js";
import { checkGoalAnswer, GOAL_QUESTIONS, parseClaims, recordGoals, segmentedInput, type Segments, subjectText } from "./goals.js";
import { type IdentifyGoalsResult, runIdentifyGoals } from "./identify_goals.js";
import factory from "./index.js";
import type { AssessedPart } from "./intent.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep, ompModelStep } from "./omp_model.js";
import { NO_WORDS_MESSAGE } from "./segment.js";

const TEXT = "Research the cache. Fix the bug.";
const PIECES = ["Research the cache.", "Fix the bug."];

const INTENT_ANSWERS = {
  Atomic: "atomic",
  Type: "task",
  Intent: "research",
  ModelStrength: 1,
  SoftwareImplementation: false,
  SoftwareArchitecture: false,
  DifficultDebugging: false,
  Research: true,
  Ambiguity: false,
  LongHorizon: false,
};

const GOAL_ANSWERS = { Role: "request", Explicit: true, Verifiable: false, Urgency: "now", Scope: "single_change" };

const listedIds = (prompt: string): string[] => [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]!);

/** A fake model for the whole run; `goals(listed, ask)` answers the merge call, `decision(part)` a part's goal questions. */
function fakeModel(
  options: {
    pieces?: string[];
    goals?: (listed: string[], ask: number) => unknown;
    decision?: (part: string) => Record<string, unknown> | Error;
  } = {},
) {
  const prompts: string[] = [];
  let asks = 0;
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("## Pieces")) return JSON.stringify({ Pieces: options.pieces ?? PIECES });
    if (prompt.startsWith("## Goals")) {
      asks += 1;
      const listed = listedIds(prompt);
      const reply = options.goals?.(listed, asks)
        ?? { Goals: [{ outcome: "Understand and fix the cache.", sources: [listed[0], listed[1]] }] };
      return JSON.stringify(reply);
    }
    const part = /Answer about this segment only:\n([\s\S]*?)\n\n(The whole input|Reply with only)/.exec(prompt)![1]!;
    if (prompt.includes("## Role")) {
      const decided = options.decision?.(part);
      if (decided instanceof Error) throw decided;
      return JSON.stringify({ ...GOAL_ANSWERS, ...decided });
    }
    return JSON.stringify(INTENT_ANSWERS);
  };
  return {
    step,
    prompts,
    goalsPrompts: () => prompts.filter((prompt) => prompt.startsWith("## Goals")),
    decisionPrompts: () => prompts.filter((prompt) => prompt.includes("## Role")),
  };
}

const run = (text: unknown, model: { step: ModelStep }) => runIdentifyGoals(text, { step: model.step });

describe("identify_goals", () => {
  it("runs intent, then each part's goal questions and one merged goals call", async () => {
    const model = fakeModel({ decision: (part) => (part.startsWith("Fix") ? { Role: "request", Urgency: "now", Explicit: false } : { Urgency: "soon" }) });
    const result = await run(TEXT, model);
    expect(result.Content).toBe(TEXT);
    expect(result.ID).toMatch(/^prm_[0-9a-f]{32}$/);
    expect(result.Parts.map((part) => part.Content)).toEqual(PIECES);
    expect(result.Parts[0]!.Intent).toEqual({ Value: "research" });
    expect(result.Parts[0]!.Goals).toEqual({
      Role: { Value: "request" },
      Explicit: true,
      Verifiable: false,
      Urgency: { Value: "soon" },
      Scope: { Value: "single_change" },
    });
    expect(result.Parts[1]!.Goals.Explicit).toBe(false);
    expect(result.Parts[1]!.Goals.Urgency).toEqual({ Value: "now" });
    expect(result.Goals).toEqual([{ outcome: "Understand and fix the cache.", sources: [result.Parts[0]!.ID, result.Parts[1]!.ID] }]);
    // 1 split + 2 assessments + 1 goals call + 2 goal decisions
    expect(model.prompts).toHaveLength(6);
    expect(model.goalsPrompts()).toHaveLength(1);
    expect(model.decisionPrompts()).toHaveLength(2);
  });

  it("shows each part's decision what identify_intent made of it, and the whole input as context", async () => {
    const model = fakeModel();
    await run(TEXT, model);
    const first = model.decisionPrompts().find((prompt) => prompt.includes("Answer about this segment only:\nResearch the cache."))!;
    expect(first).toContain("Research the cache.\nAssessed as: task / research");
    expect(first).toContain(`The whole input, for context only (do not answer about other segments):\n${TEXT}`);
    for (const field of ["Role", "Explicit", "Verifiable", "Urgency", "Scope"]) expect(first).toContain(`## ${field}`);
  });

  it("lists one JSON line per part, then the whole input, and asks for the Goals object", async () => {
    const model = fakeModel();
    const result = await run(TEXT, model);
    const prompt = model.goalsPrompts()[0]!;
    expect(listedIds(prompt)).toEqual([result.Parts[0]!.ID, result.Parts[1]!.ID, result.ID]);
    expect(prompt).toContain(`{"id":"${result.Parts[0]!.ID}","text":"Research the cache.\\nAssessed as: task / research"}`);
    expect(prompt).toContain(`{"id":"${result.ID}","text":"${TEXT}"}`);
    expect(prompt).toContain("final list of unique goals");
    expect(prompt.lastIndexOf("Respond as JSON matching this schema:")).toBeGreaterThan(prompt.indexOf(`{"id":"${result.ID}"`));
  });

  it("refuses an answer citing an unknown id with the reason, asks again, and keeps the second answer", async () => {
    const model = fakeModel({
      goals: (listed, ask) => ({ Goals: [{ outcome: "Fix the bug.", sources: [ask === 1 ? "prt_unknown" : listed[1]] }] }),
    });
    const result = await run(TEXT, model);
    expect(result.Goals).toEqual([{ outcome: "Fix the bug.", sources: [result.Parts[1]!.ID] }]);
    const second = model.goalsPrompts()[1]!;
    expect(second).toContain('fix the answer: goal 0 cites "prt_unknown", which is not the id of a listed item');
    expect(second).toContain("Your previous reply was rejected");
  });

  it("repeats no source, and lets a goal cite the whole prompt's id", async () => {
    const model = fakeModel({ goals: (listed) => ({ Goals: [{ outcome: "Implied.", sources: [listed[2], listed[2]] }] }) });
    const result = await run(TEXT, model);
    expect(result.Goals[0]!.sources).toEqual([result.ID]);
  });

  it("wraps an intent failure, a goals failure and a part's decision failure", async () => {
    await expect(run(TEXT, fakeModel({ pieces: ["nope"] }))).rejects.toThrow(/^identify intent: split the words: no valid reply after 3 attempts/);

    const goalsDown = fakeModel({ goals: () => ({ Goals: [{ outcome: "x", sources: [] }] }) });
    await expect(run(TEXT, goalsDown)).rejects.toThrow(/^identify the goals: no valid reply after 3 attempts: fix the answer: goal 0 cites no source/);

    const partDown = fakeModel({ decision: (part) => (part.startsWith("Fix") ? new Error("omp down") : {}) });
    await expect(run(TEXT, partDown)).rejects.toThrow("identify the goals: item 1: omp down");
  });

  it("refuses a goal decision off its options, naming the item", async () => {
    const model = fakeModel({ decision: () => ({ Urgency: "tomorrow" }) });
    await expect(run(TEXT, model)).rejects.toThrow(/^identify the goals: item \d: no valid reply after 3 attempts: Urgency must be one of now, soon, whenever/);
  });

  it("rejects blank input before any model call", async () => {
    for (const text of ["", "   ", "\n\t "]) {
      const model = fakeModel();
      await expect(run(text, model)).rejects.toThrow(`identify intent: ${NO_WORDS_MESSAGE}`);
      expect(model.prompts).toHaveLength(0);
    }
  });

  it("stops the other branch's model calls after one branch fails", async () => {
    let aborted = false;
    const step: ModelStep = async (prompt, signal) => {
      if (prompt.startsWith("## Pieces")) return JSON.stringify({ Pieces: PIECES });
      if (prompt.startsWith("## Goals")) throw new Error("goals down");
      if (prompt.includes("## Role")) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new Error("stopped");
      }
      return JSON.stringify(INTENT_ANSWERS);
    };
    await expect(runIdentifyGoals(TEXT, { step: async (prompt, signal) => step(prompt, signal) })).rejects.toThrow(/identify the goals: no valid reply after 3 attempts: |identify the goals: goals down/);
    expect(aborted).toBe(true);
  });

  it("reports an abort of the caller as the abort", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort(new Error("cancelled"));
      throw new Error("killed");
    };
    await expect(runIdentifyGoals(TEXT, { step, signal: controller.signal })).rejects.toThrow(/cancelled/);
  });
});

describe("goals helpers", () => {
  const part = (id: string, content: string, type = "task", intent = "research"): AssessedPart => ({
    ID: id,
    Content: content,
    Span: { Start: 0, End: content.length },
    Atomic: { Value: "atomic" },
    Type: { Value: type },
    Intent: { Value: intent },
    ModelStrength: { Point: 0, Value: "routine" },
    SoftwareImplementation: false,
    SoftwareArchitecture: false,
    DifficultDebugging: false,
    Research: false,
    Ambiguity: false,
    LongHorizon: false,
  });
  const segments: Segments = { promptId: "prm_w", content: "A & B <c>", parts: [part("prt_a", "A & B"), part("prt_b", "<c>", "", "")] };

  it("writes Go-style JSON lines: id then text, with the assessment under each part, and escapes < > &", () => {
    expect(segmentedInput(segments)).toBe(
      '{"id":"prt_a","text":"A \\u0026 B\\nAssessed as: task / research"}\n'
        + '{"id":"prt_b","text":"\\u003cc\\u003e"}\n'
        + '{"id":"prm_w","text":"A \\u0026 B \\u003cc\\u003e"}\n',
    );
    expect(subjectText(segments.parts[1]!)).toBe("<c>");
  });

  it("names an unknown id, a goal without a source or an outcome, and joins every problem", () => {
    expect(() => checkGoalAnswer(segments, [{ outcome: "x", sources: ["zzz"] }])).toThrow('fix the answer: goal 0 cites "zzz", which is not the id of a listed item');
    expect(() => checkGoalAnswer(segments, [{ outcome: " ", sources: [] }])).toThrow("fix the answer: goal 0 has no outcome; goal 0 cites no source");
    expect(() => checkGoalAnswer(segments, [{ outcome: "ok", sources: ["prt_a"] }, { outcome: "ok", sources: ["prm_w"] }])).not.toThrow();
  });

  it("parses a Goals object or a bare array and refuses a bad shape", () => {
    expect(parseClaims({ Goals: [{ outcome: "o", sources: ["a"] }] })).toEqual([{ outcome: "o", sources: ["a"] }]);
    expect(parseClaims([{ outcome: "o", sources: [] }])).toHaveLength(1);
    expect(() => parseClaims({})).toThrow(/Goals/);
    expect(() => parseClaims({ Goals: [{ outcome: 1, sources: [] }] })).toThrow(/goal 0 outcome must be a string/);
    expect(() => parseClaims({ Goals: [{ outcome: "o", sources: "a" }] })).toThrow(/goal 0 sources/);
    expect(recordGoals([{ outcome: "o", sources: ["a", "b", "a"] }])).toEqual([{ outcome: "o", sources: ["a", "b"] }]);
  });

  it("renders and checks the five goal questions", () => {
    const text = decisionPrompt("Intro.", GOAL_QUESTIONS, "part", "whole");
    expect(text).toContain('"Role": "request | promised_outcome | constraint | ask"');
    expect(text).toContain('"Explicit": true | false');
    expect(parseDecisions(GOAL_QUESTIONS, GOAL_ANSWERS).Scope).toEqual({ Value: "single_change" });
    expect(() => parseDecisions(GOAL_QUESTIONS, { ...GOAL_ANSWERS, Explicit: 0.9 })).toThrow(/Explicit must be true or false, got 0.9/);
    expect(() => parseDecisions(GOAL_QUESTIONS, { ...GOAL_ANSWERS, Role: "demand" })).toThrow(/Role must be one of request, promised_outcome, constraint, ask/);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }

  it("spawns a bare omp -p and removes its prompt file", async () => {
    let seen: { args: string[]; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], cwd: options?.cwd };
      return { stdout: " ok ", stderr: "", code: 0, killed: false };
    };
    expect(await ompModelStep(exec)("p")).toBe("ok");
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(existsSync(seen!.cwd!)).toBe(false);
    const failing = (code: number, stdout = "", killed = false): Exec => async () => ({ stdout, stderr: "bad", code, killed });
    await expect(ompModelStep(failing(2))("p")).rejects.toThrow(/model step exited 2: bad/);
    await expect(ompModelStep(failing(-1, "", true), { timeoutMs: 3000 })("p")).rejects.toThrow(/killed after 3 s/);
    await expect(ompModelStep(failing(0, " "))("p")).rejects.toThrow(/returned no text/);
  });

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as { name: string; description: string };
    expect(tool.name).toBe("identify_goals");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["identify_intent", "define_objective", "interview"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp", async () => {
    const model = fakeModel({ pieces: ["Fix it."] });
    const exec: Exec = async (command, args) => {
      if (command !== "omp") throw new Error(`unexpected ${command}`);
      return { stdout: await model.step(await readFile(args[1]!.slice(1), "utf8")), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: { text: string }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: IdentifyGoalsResult }>;
    };
    const result = await tool.execute("t1", { text: "Fix it." }, undefined, undefined);
    expect(result.details.Parts[0]!.Goals.Role).toEqual({ Value: "request" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    await expect(tool.execute("t2", { text: " " }, undefined, undefined)).rejects.toThrow(NO_WORDS_MESSAGE);
  });
});
