import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import factory from "./index.js";
import type { Exec, ModelStep } from "./omp_model.js";
import {
  batchesOf,
  decisionQuestionSize,
  expandQuestions,
  promptSubmitQuestions,
  type QuestionSource,
  REQUEST_CHARS_MAX,
  toSources,
} from "./prompt_submit_questions.js";
import type { Question } from "./questions.js";

const STATE = { user_message: "I already told you twice, run it through mise." };

const DICTATION_REPLY = { likely_dictated: 0.1, speech_disfluencies: 0.2, transcription_artifacts: 0.3 };

interface FakeModel {
  step: ModelStep;
  prompts: string[];
}

/** Answers by the question fields a prompt mentions; a fake never calls a real model. */
function fakeModel(replies: Record<string, unknown>, onCall?: (prompt: string) => void): FakeModel {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    onCall?.(prompt);
    const wanted = Object.keys(replies).filter((field) => prompt.includes(`### ${field}\n`) || prompt.includes(`## ${field}\n`));
    return JSON.stringify(Object.fromEntries(wanted.map((field) => [field, replies[field]])));
  };
  return { step, prompts };
}

const LANGUAGE: QuestionSource = {
  id: "Topics",
  kind: "language",
  question: "List the topics.",
  schema: { type: "array", items: { type: "string" }, minItems: 1 },
  examples: ["mise", "ci"],
};

describe("prompt_submit_questions", () => {
  it("answers a bundled file, an inline yes/no, an inline choice and a language question in one map", async () => {
    const model = fakeModel({
      Frustrated: 0.9,
      Urgent: 0.2,
      Kind: { Probabilities: { bug: 0.3, feature: 0.7 } },
      Topics: ["mise"],
    });
    const output = await promptSubmitQuestions(
      {
        state: STATE,
        questions: [
          { file: "prompt_answers" },
          { id: "Urgent", question: "Is it urgent?", choices: { true: "", false: "" } },
          { id: "Kind", question: "Which kind?", choices: { bug: "broken", feature: "new" } },
          LANGUAGE,
        ],
      },
      model.step,
    );
    expect(output.answers).toEqual({
      Frustrated: 0.9,
      Urgent: 0.2,
      Kind: { Value: "feature", Probabilities: { bug: 0.3, feature: 0.7 } },
      Topics: ["mise"],
    });
    // One decision batch (all three decisions) and one language call.
    expect(model.prompts).toHaveLength(2);
    const decisionPrompt = model.prompts.find((p) => p.includes("## State"))!;
    expect(decisionPrompt).toContain(JSON.stringify(STATE, null, 2));
    for (const field of ["Frustrated", "Urgent", "Kind"]) expect(decisionPrompt).toContain(`### ${field}`);
    const languagePrompt = model.prompts.find((p) => p.includes("## Topics"))!;
    expect(languagePrompt).toContain(JSON.stringify(STATE, null, 2));
    expect(languagePrompt).toContain("Example:\nmise");
  });

  it("loads the dictation file: three yes/no questions", async () => {
    const model = fakeModel(DICTATION_REPLY);
    const output = await promptSubmitQuestions({ state: "um so like, run the thing", questions: [{ file: "dictation" }] }, model.step);
    expect(output.answers).toEqual(DICTATION_REPLY);
  });

  it("shows a string state as a JSON string to decisions and as words to language questions", async () => {
    const model = fakeModel({ Frustrated: 0.1, Topics: ["a"] });
    await promptSubmitQuestions({ state: "plain words", questions: [{ file: "prompt_answers" }, LANGUAGE] }, model.step);
    expect(model.prompts.find((p) => p.includes("## State"))).toContain('"plain words"');
    expect(model.prompts.find((p) => p.includes("## Topics"))).toContain("Prompt:\nplain words\n");
  });

  it("asks a language reply again with the reason when it breaks the schema", async () => {
    let call = 0;
    const model = fakeModel({}, () => {});
    const step: ModelStep = async (prompt) => {
      model.prompts.push(prompt);
      return JSON.stringify({ Topics: call++ === 0 ? [] : ["ci"] });
    };
    const output = await promptSubmitQuestions({ state: "x", questions: [LANGUAGE] }, step);
    expect(output.answers).toEqual({ Topics: ["ci"] });
    expect(model.prompts[1]).toContain("fewer than 1 items");
  });

  it("splits decision questions into batches by size and answers every batch", async () => {
    const big = "x".repeat(REQUEST_CHARS_MAX - 100);
    const model = fakeModel({ A: 0.1, B: 0.2, C: 0.3 });
    const output = await promptSubmitQuestions(
      {
        state: STATE,
        questions: [
          { id: "A", question: big, choices: { true: "", false: "" } },
          { id: "B", question: big, choices: { true: "", false: "" } },
          { id: "C", question: "short", choices: { true: "", false: "" } },
        ],
      },
      model.step,
    );
    expect(output.answers).toEqual({ A: 0.1, B: 0.2, C: 0.3 });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).toContain("### A\n");
    expect(model.prompts[0]).not.toContain("### B\n");
    expect(model.prompts[1]).toContain("### B\n");
    expect(model.prompts[1]).toContain("### C\n");
  });

  it("batchesOf keeps order, puts an oversized item alone, and sums criteria sizes", () => {
    expect(batchesOf([5, 5, 20, 5], (n) => n, 10)).toEqual([[5, 5], [20], [5]]);
    const question: Question = { field: "Ab", kind: "choice", instructions: "xyz", criteria: { a: "1", bc: "22" } };
    expect(decisionQuestionSize(question)).toBe(2 + 6 + 3 + 1 + 1 + 2 + 2);
    const score: Question = { field: "S", kind: "score", instructions: "i", criteria: ["aa", "b"] };
    expect(decisionQuestionSize(score)).toBe(1 + 5 + 1 + 2 + 1);
  });

  describe("fails before any model is asked", () => {
    async function refused(input: { state: unknown; questions: QuestionSource[] }, pattern: string | RegExp) {
      const model = fakeModel({});
      await expect(promptSubmitQuestions(input, model.step)).rejects.toThrow(pattern);
      expect(model.prompts).toHaveLength(0);
    }

    it("an unknown file", () => refused({ state: STATE, questions: [{ file: "nope" }] }, 'unknown question file "nope"'));
    it("a file path instead of a bundled name", () => refused({ state: STATE, questions: [{ file: "/etc/passwd" }] }, 'unknown question file "/etc/passwd"'));
    it("a duplicate id across a file and an inline question", () =>
      refused(
        { state: STATE, questions: [{ file: "prompt_answers" }, { id: "Frustrated", question: "q", choices: { true: "", false: "" } }] },
        'question field "Frustrated" is declared more than once',
      ));
    it("an empty choices map", () => refused({ state: STATE, questions: [{ id: "Q", question: "q", choices: {} }] }, 'question "Q" has no choices'));
    it("an empty id", () => refused({ state: STATE, questions: [{ id: "", question: "q", choices: { a: "" } }] }, "must not be empty"));
    it("a schema the checker cannot enforce", () =>
      refused(
        { state: STATE, questions: [{ id: "Q", kind: "language", question: "q", schema: { type: "string", if: {} } }] },
        'question Q has a schema that cannot be checked',
      ));
    it("no questions", () => refused({ state: STATE, questions: [] }, "at least one question"));
    it("a missing state", () => refused({ state: undefined, questions: [{ file: "prompt_answers" }] }, "state is required"));
  });

  it("expands inline sources: {true,false} is yes/no, anything else a choice, in source order", () => {
    const expanded = expandQuestions([
      { id: "B", question: "b", choices: { false: "n", true: "y" } },
      { id: "C", question: "c", choices: { x: "1", y: "2", z: "3" } },
      LANGUAGE,
    ]);
    expect(expanded.decisions.map((q) => [q.field, q.kind])).toEqual([["B", "noul"], ["C", "choice"]]);
    expect(expanded.language.map((q) => q.field)).toEqual(["Topics"]);
  });

  it("fails the whole call, naming the cause, when one batch fails, and aborts the others", async () => {
    let languageSignal: AbortSignal | undefined;
    const step: ModelStep = async (prompt, signal) => {
      if (prompt.includes("## State")) throw new Error("decision model is down");
      languageSignal = signal;
      const { promise, reject } = Promise.withResolvers<string>();
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    };
    await expect(
      promptSubmitQuestions({ state: STATE, questions: [{ file: "prompt_answers" }, LANGUAGE] }, step),
    ).rejects.toThrow("prompt_submit_questions: decision model is down");
    expect(languageSignal?.aborted).toBe(true);
  });

  it("rethrows the caller's own abort untouched", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    const step: ModelStep = async (_p, signal) => {
      signal?.throwIfAborted();
      return "{}";
    };
    await expect(
      promptSubmitQuestions({ state: STATE, questions: [{ file: "prompt_answers" }] }, step, controller.signal),
    ).rejects.toThrow("cancelled by user");
  });
});

describe("toSources", () => {
  it("sorts flat questions into file, decision and language sources, treating null as absent", () => {
    expect(
      toSources([
        { file: "dictation", id: null, kind: null, question: null, choices: null, schema: null, examples: null },
        { id: "A", question: "q", choices: { true: "", false: "" }, kind: null },
        { id: "T", kind: "language", question: "q", schema: { type: "string" }, examples: ["x"] },
        { id: "U", kind: "language", question: "q", schema: { type: "string" } },
      ]),
    ).toEqual([
      { file: "dictation" },
      { id: "A", question: "q", choices: { true: "", false: "" } },
      { id: "T", kind: "language", question: "q", schema: { type: "string" }, examples: ["x"] },
      { id: "U", kind: "language", question: "q", schema: { type: "string" } },
    ]);
  });

  it("refuses a malformed question naming its position", () => {
    expect(() => toSources([{ file: "dictation", id: "A" }])).toThrow("questions[0]: a file source takes only `file`, also got id");
    expect(() => toSources([{ question: "q", choices: { a: "" } }])).toThrow("questions[0]: `id` is required");
    expect(() => toSources([{ id: "A", question: "", choices: { a: "" } }])).toThrow("`question` is required");
    expect(() => toSources([{ id: "A", question: "q" }])).toThrow("a decision question needs `choices`");
    expect(() => toSources([{ id: "A", question: "q", kind: "language" }])).toThrow("needs `schema`");
    expect(() => toSources([{ id: "A", question: "q", kind: "language", schema: {}, choices: { a: "" } }])).toThrow("takes `schema`, not `choices`");
    expect(() => toSources([{ id: "A", question: "q", kind: "decision", choices: { a: "" } }])).toThrow('`kind` must be "language" or omitted');
    expect(() => toSources([{ id: "A", question: "q", choices: { a: "" }, schema: {} }])).toThrow('belong to kind "language"');
    expect(() => toSources([{ id: "ok", question: "q", choices: { a: "" } }, {}])).toThrow("questions[1]");
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    // The load check against omp's own zod lives outside the suite; here a tiny builder records the schema shape.
    const schema = (kind: string) => {
      const node: Record<string, unknown> = { kind };
      const chain = new Proxy(node, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
      return chain;
    };
    const zod = new Proxy({}, { get: (_t, kind) => (..._a: unknown[]) => schema(String(kind)) });
    return { zod, exec, cwd: "/", logger: {} } as never;
  }
  interface Tool {
    name: string;
    description: string;
    execute: (id: string, params: { state: unknown; questions: QuestionSource[] }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    expect(tool.name).toBe("prompt_submit_questions");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["prompt_answers", "answer_questions"]) expect(tool.description).toContain(sibling);
  });

  it("answers through execute with a fake omp process", async () => {
    const exec: Exec = async (_command, args) => {
      const prompt = await readFile(args[1]!.slice(1), "utf8");
      expect(prompt).toContain("run it through mise");
      return { stdout: '{"Frustrated": 0.6}', stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as Tool;
    const out = await tool.execute("t", { state: STATE, questions: [{ file: "prompt_answers" }] }, undefined, undefined);
    expect(out.details).toEqual({ answers: { Frustrated: 0.6 } });
    expect(JSON.parse(out.content[0]!.text)).toEqual(out.details as object);
  });
});
