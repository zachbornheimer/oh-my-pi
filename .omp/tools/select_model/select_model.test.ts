import { describe, expect, it } from "bun:test";
import { DECISION_CATALOG, type DecisionEntry, languageId } from "./catalog.js";
import factory from "./index.js";
import { needOf } from "./need.js";
import { rankDecisionModels, withDefaultDecisionOrder } from "./ranking.js";
import { NO_PROMPT_MESSAGE, selectModel } from "./select.js";

const DECISION_DEFAULT = ["openrouter/~typesafe/jev-latest", "typesafe/jev-1.13", "ollama/nimble"];

interface Case {
  id: string;
  env: Record<string, string>;
  text: string;
  candidates?: string[];
  error?: string;
}

/** agentmux's own cases (the Mastra twin's fixtures/cases.json, from agentmux's select_model tests). */
const CASES: Case[] = [
  { id: "F1-parse-requires-prompt-empty", env: {}, text: "", error: NO_PROMPT_MESSAGE },
  { id: "F1-parse-requires-prompt-blank", env: {}, text: "   \n\t", error: NO_PROMPT_MESSAGE },
  { id: "F2-decision-prompt-ranks-the-decision-model", env: {}, text: "classify this decision", candidates: DECISION_DEFAULT },
  { id: "F2-decision-prompt-pinned", env: { AGENTMUX_DECISION_MODEL: "ollama/nimble" }, text: "is this a bug", candidates: ["ollama/nimble"] },
  {
    id: "F2-decision-pin-list-keeps-order",
    env: { AGENTMUX_DECISION_MODEL: " ollama/clef , typesafe/jev-1.13 ,," },
    text: "is this a bug",
    candidates: ["ollama/clef", "typesafe/jev-1.13"],
  },
  { id: "F2-decision-blank-pin-is-no-pin", env: { AGENTMUX_DECISION_MODEL: "   " }, text: "is this a bug", candidates: DECISION_DEFAULT },
  {
    id: "F2-decision-unknown-pin",
    env: { AGENTMUX_DECISION_MODEL: "ollama/nope" },
    text: "is this a bug",
    error: 'select a model for "is this a bug": unknown decision model "ollama/nope": known models are ollama/nimble, ollama/clef, typesafe/jev-1.13, openrouter/~typesafe/jev-latest',
  },
  { id: "F3-text-prompt-answers-the-default-language-model", env: {}, text: "write a description of this project", candidates: ["openrouter/auto"] },
  { id: "F3-text-prompt-pinned", env: { AGENTMUX_LANGUAGE_MODEL: "ollama/qwen3.8:27b" }, text: "write a summary", candidates: ["ollama/qwen3.8:27b"] },
  {
    id: "F3-text-pin-list-keeps-order",
    env: { AGENTMUX_LANGUAGE_MODEL: "ollama/qwen3.8:27b,openrouter/qwen/qwen3.8-27b" },
    text: "generate a changelog",
    candidates: ["ollama/qwen3.8:27b", "openrouter/qwen/qwen3.8-27b"],
  },
  {
    id: "F3-text-unknown-route",
    env: { AGENTMUX_LANGUAGE_MODEL: "xai/grok" },
    text: "write a summary",
    // The Mastra twin's own fixture lists two routes; its catalog has four (local and omp were added after).
    error: 'select a model for "write a summary": unknown language model "xai/grok": use openrouter/<model>, ollama/<model>, local/<model>, omp/<model>',
  },
  { id: "F3-language-pin-does-not-touch-a-decision-prompt", env: { AGENTMUX_LANGUAGE_MODEL: "ollama/qwen3.8:27b" }, text: "is this a bug", candidates: DECISION_DEFAULT },
  { id: "F3-decision-pin-does-not-touch-a-text-prompt", env: { AGENTMUX_DECISION_MODEL: "ollama/nimble" }, text: "WRITE a summary", candidates: ["openrouter/auto"] },
  {
    id: "F4-string-lists-candidates-in-order",
    env: { AGENTMUX_LANGUAGE_MODEL: "ollama/first,openrouter/second/model" },
    text: "describe it",
    candidates: ["ollama/first", "openrouter/second/model"],
  },
];

describe("agentmux parity: every fixture", () => {
  it.each(CASES.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    if (fixture.error !== undefined) {
      expect(() => selectModel(fixture.text, fixture.env)).toThrow(fixture.error);
      return;
    }
    expect(selectModel(fixture.text, fixture.env)).toEqual({ Candidates: fixture.candidates! });
  });

  it("does not read the process environment when handed one", () => {
    process.env.AGENTMUX_DECISION_MODEL = "ollama/clef";
    try {
      expect(selectModel("is this a bug", {})).toEqual({ Candidates: DECISION_DEFAULT });
    } finally {
      delete process.env.AGENTMUX_DECISION_MODEL;
    }
  });
});

describe("input", () => {
  it.each([undefined, null, 3, {}])("refuses a non-string prompt %j", (text) => {
    expect(() => selectModel(text, {})).toThrow(NO_PROMPT_MESSAGE);
  });

  it("ranks for the trimmed prompt and quotes it in a failure", () => {
    expect(() => selectModel("  write it \n", { AGENTMUX_LANGUAGE_MODEL: "nope" })).toThrow('select a model for "write it": unknown language model "nope"');
  });

  it.each(["openrouter/", "/x", "local", ""])("refuses the malformed language route %j", (id) => {
    expect(() => languageId(id)).toThrow(/unknown language model/);
  });

  it.each(["local/anthropic/claude-sonnet", "omp/default", "ollama/x:1"])("accepts the language route %s", (id) => {
    expect(languageId(id)).toBe(id);
  });
});

describe("needOf", () => {
  it.each(["descri", "write", "generat", "llm", "text"])("%s asks for a language model, in any case", (word) => {
    expect(needOf(`please ${word.toUpperCase()} it`)).toBe("language");
  });

  it("asks for a decision model otherwise", () => {
    expect(needOf("classify this decision")).toBe("decision");
  });

  it.each(["describing the repo", "rewrite the intro", "I am writing docs", "written notes", "textual output", "LLM output", "re-write it"])(
    "FIXED: %s is a text task",
    (prompt) => {
      expect(needOf(prompt)).toBe("language");
    },
  );

  it.each(["select the context window", "fix the contextual bug", "subtext handling", "is this a bug", "overwrite the flag", "indescribable"])(
    "FIXED: %s is not a text task (agentmux matched the substring anywhere)",
    (prompt) => {
      expect(needOf(prompt)).toBe("decision");
    },
  );
});

describe("rankDecisionModels (agentmux rank)", () => {
  const entry = (id: string, inputPerMillion: number, outputPerMillion = 0, strength: DecisionEntry["strength"] = "unknown"): DecisionEntry => ({
    id,
    strength,
    listPrice: { inputPerMillion, outputPerMillion },
  });

  it("orders unknown-strength models by list price, then id, and never ranks a free model unnamed", () => {
    const catalog = [entry("b", 2), entry("free", 0), entry("c", 1), entry("a", 2), entry("d", 1, 1)];
    expect(rankDecisionModels(catalog)).toEqual(["c", "a", "b", "d"]);
  });

  it("never ranks a named-only model unnamed", () => {
    expect(rankDecisionModels([{ ...entry("named", 1), namedOnly: true }, entry("open", 1)])).toEqual(["open"]);
  });

  it("ranks a model of unknown strength after every vetted one, however cheap it is", () => {
    expect(rankDecisionModels([entry("cheap-unknown", 0.1), entry("dear-routine", 9, 0, "routine")])).toEqual(["dear-routine", "cheap-unknown"]);
  });

  it("ranks the weakest vetted model first, since a model is never stronger than the work asks for", () => {
    const catalog = [entry("deep", 1, 0, "deep"), entry("routine", 5, 0, "routine"), entry("reasoning", 3, 0, "reasoning")];
    expect(rankDecisionModels(catalog)).toEqual(["routine", "reasoning", "deep"]);
  });

  it("breaks a strength tie by list price, then id", () => {
    const catalog = [entry("z", 1, 0, "reasoning"), entry("b", 2, 0, "reasoning"), entry("a", 2, 0, "reasoning")];
    expect(rankDecisionModels(catalog)).toEqual(["z", "a", "b"]);
  });

  it("drops a model weaker than the strength the need asks for", () => {
    const catalog = [entry("routine", 1, 0, "routine"), entry("deep", 2, 0, "deep"), entry("unknown", 1)];
    expect(rankDecisionModels(catalog, "reasoning")).toEqual(["deep"]);
  });

  it("ranks the shipped catalog to the one unnamed model", () => {
    expect(rankDecisionModels(DECISION_CATALOG)).toEqual(["typesafe/jev-1.13"]);
  });
});

describe("withDefaultDecisionOrder (agentmux withDefaultDecisionOrder)", () => {
  const entry = (id: string, strength: DecisionEntry["strength"] = "unknown"): DecisionEntry => ({
    id,
    strength,
    listPrice: { inputPerMillion: 1, outputPerMillion: 0 },
  });
  const catalog = [entry("openrouter/~typesafe/jev-latest"), entry("ollama/nimble"), entry("other")];

  it("puts the default route first and the local fallback last, whatever the ranking said", () => {
    expect(withDefaultDecisionOrder(["other", "ollama/nimble", "openrouter/~typesafe/jev-latest"], catalog)).toEqual([
      "openrouter/~typesafe/jev-latest",
      "other",
      "ollama/nimble",
    ]);
  });

  it("names the default route and the fallback even when the ranking left them out", () => {
    expect(withDefaultDecisionOrder([], catalog)).toEqual(["openrouter/~typesafe/jev-latest", "ollama/nimble"]);
  });

  it("leaves out a model the catalog lacks or that is too weak for the need", () => {
    expect(withDefaultDecisionOrder([], [entry("ollama/nimble")])).toEqual(["ollama/nimble"]);
    expect(withDefaultDecisionOrder([], catalog, "reasoning")).toEqual([]);
  });
});

describe("the tool", () => {
  function pi() {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec: async () => ({}), cwd: "/", logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi()) as { name: string; description: string };
    expect(tool.name).toBe("select_model");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["classify_prompt_parts", "task_class"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute and reads the process environment", async () => {
    const tool = factory(pi()) as unknown as { execute: (id: string, params: { text: string }) => Promise<{ content: { text: string }[]; details: unknown }> };
    process.env.AGENTMUX_LANGUAGE_MODEL = "omp/default";
    try {
      const result = await tool.execute("id", { text: "write a note" });
      expect(result.details).toEqual({ Candidates: ["omp/default"] });
      expect(JSON.parse(result.content[0]!.text)).toEqual({ Candidates: ["omp/default"] });
    } finally {
      delete process.env.AGENTMUX_LANGUAGE_MODEL;
    }
  });

  it("fails the call, not a success, on a blank prompt", async () => {
    const tool = factory(pi()) as unknown as { execute: (id: string, params: { text: string }) => Promise<unknown> };
    await expect(tool.execute("id", { text: " " })).rejects.toThrow(NO_PROMPT_MESSAGE);
  });
});
