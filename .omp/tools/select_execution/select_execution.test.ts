import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import factory from "./index.js";
import { type ExecutionSelection, selectExecution } from "./select.js";

interface Case {
  readonly id: string;
  readonly source: string;
  readonly input: unknown;
  readonly expected: { readonly result: ExecutionSelection } | { readonly error: string };
}

/** 50 cases the agentmux binary answered; the expected values were never computed in TypeScript. */
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Case[];

const run = (input: unknown) => selectExecution(input as never);

describe("agentmux parity: every fixture, verbatim", () => {
  it.each(cases.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    if ("error" in fixture.expected) {
      expect(() => run(fixture.input)).toThrow(fixture.expected.error);
      return;
    }
    const output = run(fixture.input);
    expect(output).toEqual(fixture.expected.result);
    // toEqual ignores undefined keys; the wire document must omit empty optional fields exactly.
    expect(JSON.parse(JSON.stringify(output))).toEqual(fixture.expected.result);
  });

  it("covers each Go test that selects", () => {
    const sources = new Set(cases.map((fixture) => fixture.source));
    for (const name of [
      "TestSelectExecutionClassByShape",
      "TestSelectExecutionIsStable",
      "TestSelectExecutionNoNewInformationNeverRepeatsClass",
      "TestSelectExecutionFailureWithNewInformationRetriesOnce",
      "TestSelectExecutionRespectsForbiddenAndConflicts",
      "TestSelectExecutionGatesProductionWithoutStrongVerifier",
      "TestSelectExecutionHumanIsTerminal",
    ]) {
      expect(sources).toContain(name);
    }
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

describe("selectExecution", () => {
  it("is stable and returns the tools sorted and de-duplicated", () => {
    const input = { capability: "work", shape: "implementation", required_tools: ["go", "git", "go"] };
    const first = run(input);
    expect(run(input)).toEqual(first);
    expect(first.strategy.tools).toEqual(["git", "go"]);
  });

  it("treats JSON null like an absent field", () => {
    const output = run({
      capability: "work",
      shape: "classification",
      prior: null,
      constraints: null,
      required_tools: null,
      permissions: null,
      maturity: null,
      verifier: null,
      human_approval: null,
      credentials: null,
    });
    expect(output.compute_class).toBe("structured_inference");
    expect(output.strategy).toEqual({ kind: "structured_decision_inference" });
  });

  it("refuses a null or empty call", () => {
    expect(() => run(null)).toThrow("capability is required");
    expect(() => run({})).toThrow("capability is required");
  });

  it("does not mutate the caller's input", () => {
    const input = { capability: "work", shape: "deterministic", required_tools: ["b", "a"], constraints: { forbid: ["human", "generative"] } };
    const before = structuredClone(input);
    run(input);
    expect(input).toEqual(before);
  });
});

describe("the tool", () => {
  const zod = factoryZod();
  const tool = factory({ zod, cwd: "/tmp", exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }) } as never) as {
    name: string;
    description: string;
    parameters: { safeParse?: (value: unknown) => { success: boolean } };
    execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal: undefined) => Promise<{ content: { text: string }[]; details: ExecutionSelection }>;
  };

  it("returns the selection as text and as details", async () => {
    const result = await tool.execute("id", { capability: "work", shape: "description", maturity: "production" }, undefined, undefined, undefined);
    expect(result.details.compute_class).toBe("generative");
    expect(result.details.gates).toEqual(["human_review"]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("throws the capability's own error for a bad request", async () => {
    await expect(tool.execute("id", { capability: "work", shape: "vibes" }, undefined, undefined, undefined)).rejects.toThrow('unknown shape "vibes"');
  });
});

function factoryZod() {
  // The real pi.zod is exercised by the load check; this suite only needs a schema builder that records nothing.
  const chain: Record<string, unknown> = new Proxy(() => chain, {
    get: (_target, key) => (key === "then" ? undefined : chain),
    apply: () => chain,
  }) as never;
  return new Proxy({}, { get: () => () => chain }) as never;
}
