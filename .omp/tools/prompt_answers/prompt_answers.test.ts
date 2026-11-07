import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import factory from "./index.js";
import type { Exec, ModelStep } from "./omp_model.js";
import { MESSAGE_LEAD, NO_WORDS_MESSAGE, promptAnswers, standingQuestions } from "./prompt_answers.js";

const WORDS = "I already told you twice, run it through mise.";

function replying(...replies: string[]): { step: ModelStep; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    return replies[Math.min(call++, replies.length - 1)]!;
  };
  return { step, prompts };
}

describe("prompt_answers", () => {
  it("asks the bundled standing question in one call, showing the trimmed words as JSON state", async () => {
    const model = replying('{"Frustrated": 0.92}');
    const output = await promptAnswers({ text: `  ${WORDS}\n` }, model.step);
    expect(output).toEqual({ answers: { Frustrated: 0.92 } });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain(JSON.stringify({ [MESSAGE_LEAD]: WORDS }, null, 2));
    expect(model.prompts[0]).toContain("### Frustrated");
    expect(model.prompts[0]).toContain("untrusted data");
    expect(standingQuestions().map((q) => [q.field, q.kind])).toEqual([["Frustrated", "noul"]]);
  });

  it("accepts the reply fenced as a json block", async () => {
    const output = await promptAnswers({ text: WORDS }, replying('```json\n{"Frustrated": 0.1}\n```').step);
    expect(output.answers.Frustrated).toBe(0.1);
  });

  it("refuses blank text without asking a model", async () => {
    const model = replying('{"Frustrated": 0.5}');
    await expect(promptAnswers({ text: " \n\t " }, model.step)).rejects.toThrow(NO_WORDS_MESSAGE);
    expect(model.prompts).toHaveLength(0);
  });

  it("asks again with the reason when the reply is out of range, and returns the corrected one", async () => {
    const model = replying('{"Frustrated": 7}', '{"Frustrated": 0.7}');
    const output = await promptAnswers({ text: WORDS }, model.step);
    expect(output.answers.Frustrated).toBe(0.7);
    expect(model.prompts[1]).toContain("question Frustrated must be a number from 0 to 1, got 7");
  });

  it("throws `answer prompt: <cause>` after three bad replies and guesses no answer", async () => {
    const model = replying("I think the user is annoyed.");
    await expect(promptAnswers({ text: WORDS }, model.step)).rejects.toThrow(
      /^answer prompt: no valid reply after 3 attempts: the reply is not JSON/,
    );
    expect(model.prompts).toHaveLength(3);
  });

  it("throws `answer prompt: <cause>` when the model process fails", async () => {
    const step: ModelStep = async () => {
      throw new Error("model step exited 1: boom");
    };
    await expect(promptAnswers({ text: WORDS }, step)).rejects.toThrow("answer prompt: model step exited 1: boom");
  });

  it("rethrows the caller's own abort untouched", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    const step: ModelStep = async (_p, signal) => {
      signal?.throwIfAborted();
      return "{}";
    };
    await expect(promptAnswers({ text: WORDS }, step, controller.signal)).rejects.toThrow("cancelled by user");
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
    execute: (id: string, params: { text: string }, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    expect(tool.name).toBe("prompt_answers");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["prompt_submit_questions", "answer_questions"]) expect(tool.description).toContain(sibling);
  });

  it("answers through execute with a fake omp process", async () => {
    const seen: string[] = [];
    const exec: Exec = async (command, args) => {
      seen.push(command, ...args);
      expect(await readFile(args[1]!.slice(1), "utf8")).toContain(WORDS);
      return { stdout: '{"Frustrated": 0.95}', stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as Tool;
    const out = await tool.execute("t1", { text: WORDS }, undefined, undefined);
    expect(out.details).toEqual({ answers: { Frustrated: 0.95 } });
    expect(JSON.parse(out.content[0]!.text)).toEqual(out.details as object);
    expect(seen[0]).toBe("omp");
    expect(seen).toContain("--no-tools");
  });

  it("fails through execute on blank text", async () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as unknown as Tool;
    await expect(tool.execute("t2", { text: "  " }, undefined, undefined)).rejects.toThrow(NO_WORDS_MESSAGE);
  });
});
