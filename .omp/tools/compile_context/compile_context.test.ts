import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { compileContext } from "./compile.js";
import factory from "./index.js";
import { type CompileContextResult, readInput } from "./schemas.js";

interface Case {
  readonly id: string;
  readonly source: string;
  readonly input: unknown;
  readonly expected: { readonly result: CompileContextResult } | { readonly error: string };
}

const cases = JSON.parse(readFileSync(new URL("./fixtures/cases.json", import.meta.url), "utf8")) as Case[];

const compile = (input: unknown): CompileContextResult => compileContext(readInput(input));

/** A chainable stand-in for `pi.zod`: every method returns the same schema, so a factory can build its parameters. */
function fakeZod(): unknown {
  const schema: unknown = new Proxy(() => schema, { get: () => () => schema, apply: () => schema });
  return new Proxy({}, { get: () => () => schema });
}

function tool() {
  const built = factory({ zod: fakeZod() } as never);
  if (Array.isArray(built) || built instanceof Promise) throw new Error("compile_context returns one tool");
  return built;
}

describe("agentmux parity: every fixture, verbatim", () => {
  for (const fixture of cases) {
    it(fixture.id, () => {
      if ("error" in fixture.expected) {
        expect(() => compile(fixture.input)).toThrow(fixture.expected.error);
        return;
      }
      expect(compile(fixture.input)).toEqual(fixture.expected.result);
    });
  }

  it("covers each Go test of compileContext", () => {
    const sources = new Set(cases.map((fixture) => fixture.source.split("/")[0]));
    for (
      const name of [
        "TestCompileContextRanksByRelevanceWithStableTies",
        "TestCompileContextKeepsRequiredEvidenceFirst",
        "TestCompileContextDurableTruthPreserved",
        "TestCompileContextEmptyObligationIDsMeansAllLive",
        "TestCompileContextBudgetOmitsWithReason",
        "TestCompileContextOmitsTranscriptEmptyAndDuplicateEvidence",
        "TestCompileContextRequiredOverBudgetIsError",
        "TestCompileContextRejectsBadInput",
        "TestCompileContextIsDeterministicAndEstimatesTokens",
        "TestCompileContextTypedAndDynamicAgree",
      ]
    ) {
      expect(sources).toContain(name);
    }
  });
});

describe("input reading", () => {
  it("reads null lists, strings and objects as Go's zero values", () => {
    const withNulls = readInput({
      state: { project_id: "p", name: null, intent: null, obligations: null, decisions: null, skills: null },
      work: { id: null, text: "t", obligation_ids: null },
      evidence: null,
      budget: null,
    });
    const withZeros = readInput({
      state: { project_id: "p", name: "", intent: "", obligations: [], decisions: [], skills: [] },
      work: { id: "", text: "t", obligation_ids: [] },
      evidence: [],
      budget: {},
    });
    expect(compileContext({ ...withNulls, budget: { max_items: 5, max_chars: 0, max_tokens: 0 } })).toEqual(
      compileContext({ ...withZeros, budget: { max_items: 5, max_chars: 0, max_tokens: 0 } }),
    );
    expect(withNulls.budget).toEqual({ max_items: 0, max_chars: 0, max_tokens: 0 });
    expect(withNulls.state.obligations).toEqual([]);
  });

  it("reads a null or missing state as the zero project state, which the run refuses", () => {
    expect(readInput({ state: null }).state.project_id).toBe("");
    expect(() => compile({ state: null, work: { text: "t" }, budget: { max_items: 1 } })).toThrow(
      "compile_context: state.project_id is empty",
    );
  });

  it("refuses a value of the wrong type naming its path", () => {
    expect(() => readInput({ state: { project_id: 7 } })).toThrow("state.project_id must be a string");
    expect(() => readInput({ budget: { max_items: 1.5 } })).toThrow("budget.max_items must be an integer");
    expect(() => readInput({ evidence: "x" })).toThrow("evidence must be a list");
    expect(() => readInput({ evidence: [{ required: "yes" }] })).toThrow("evidence[0].required must be true or false");
    expect(() => readInput({ state: [] })).toThrow("state must be an object");
    expect(() => readInput("nope")).toThrow("input must be an object");
  });
});

describe("the tool", () => {
  const first = cases.find((fixture) => "result" in fixture.expected)!;

  it("is a deterministic bundle with provenance on every item", () => {
    for (const fixture of cases.filter((candidate) => "result" in candidate.expected)) {
      const one = compile(fixture.input);
      expect(compile(fixture.input)).toEqual(one);
      for (const item of one.items) {
        expect(item.provenance.source).not.toBe("");
        expect(item.provenance.ref).not.toBe("");
      }
    }
  });

  it("never leaks transcript text into any item", () => {
    const fixture = cases.find((candidate) => candidate.id === "omits-transcript-empty-and-duplicate-evidence")!;
    expect(JSON.stringify(compile(fixture.input).items)).not.toContain("TRANSCRIPT-SECRET");
  });

  it("returns JSON text and the typed result as details, and throws for invalid input", async () => {
    const result = await tool().execute("id", first.input as never, undefined, undefined as never, undefined);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      (first.expected as { result: CompileContextResult }).result,
    );
    expect(result.details).toEqual((first.expected as { result: CompileContextResult }).result);
    await expect(
      tool().execute("id", { state: { project_id: "p" }, work: { text: "t" } } as never, undefined, undefined as never, undefined),
    ).rejects.toThrow("budget must set max_items, max_chars, or max_tokens");
  });

  it("declares itself discoverable: no essential load mode", () => {
    expect(tool().name).toBe("compile_context");
    expect((tool() as { loadMode?: string }).loadMode).toBeUndefined();
  });
});
