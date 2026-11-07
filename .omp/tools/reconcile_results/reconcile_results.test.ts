import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import factory from "./index.js";
import { normalizeInput, type Reconciliation, reconcileResults } from "./reconcile.js";

interface Case {
  readonly id: string;
  readonly source: string;
  readonly input: unknown;
  readonly expected: { readonly result: Reconciliation } | { readonly error: string };
}

/** 42 cases the agentmux binary answered; the expected values were never computed in TypeScript. */
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Case[];

const errorOf = (input: unknown): string => {
  try {
    reconcileResults(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the run to fail");
};

const inputWith = (fixtureId: string) => cases.find((fixture) => fixture.id === fixtureId)!.input;

describe("agentmux parity: every fixture, verbatim", () => {
  it.each(cases.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    if ("error" in fixture.expected) {
      expect(errorOf(fixture.input)).toContain(fixture.expected.error);
      return;
    }
    const output = reconcileResults(fixture.input);
    expect(output).toEqual(fixture.expected.result);
    expect(JSON.parse(JSON.stringify(output))).toEqual(fixture.expected.result);
  });

  it("covers each Go test", () => {
    const sources = new Set(cases.map((fixture) => fixture.source));
    for (const test of [
      "TestReconcileSatisfiedNeedsEvidenceAndPreservesUnaffected",
      "TestReconcileExecutorClaimIsNotEvidence",
      "TestReconcileNonSuccessNeverSatisfies",
      "TestReconcile_UnknownAttemptNeverSatisfiesOrReplays",
      "TestReconcileRejectsBadDecisions",
      "TestReconcileNeverReopensSatisfied",
      "TestReconcileIsIdempotentAndOrderIndependent",
    ]) {
      expect(sources).toContain(test);
    }
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });
});

describe("the run", () => {
  it("does not mutate the caller's input", () => {
    const input = structuredClone(inputWith("order-independent"));
    reconcileResults(input);
    expect(input).toEqual(inputWith("order-independent"));
  });

  it("gives the same output for the same input", () => {
    const input = inputWith("idempotent-duplicate-input");
    expect(reconcileResults(input)).toEqual(reconcileResults(input));
  });

  it("never lets an executor claim satisfy: a failed result with execution_completed stays open", () => {
    const output = reconcileResults(inputWith("non-success-never-satisfies"));
    const statuses = (output.projected.obligations as { status: string }[]).map((obligation) => obligation.status);
    expect(statuses).toEqual(["open", "blocked", "open"]);
    expect(output.changes?.map((change) => change.action)).toEqual(["block"]);
  });
});

describe("input normalisation", () => {
  it("reads null lists, strings and objects as Go's zero values", () => {
    const withNulls = normalizeInput({
      state: {
        project_id: "p",
        name: null,
        obligations: [{ id: "o1", goal_ids: null, evidence: null, origin: null }],
        decisions: null,
        facts: null,
        skills: null,
        runs: null,
      },
      results: [{ obligation_id: "o1", status: null, evidence: null, failure: { class: null, rationale: null } }],
    });
    const withZeros = normalizeInput({
      state: {
        project_id: "p",
        name: "",
        obligations: [{ id: "o1", goal_ids: [], evidence: "", origin: {} }],
        decisions: [],
        facts: [],
        skills: [],
        runs: [],
      },
      results: [{ obligation_id: "o1", status: "", evidence: "", failure: { class: "", rationale: [] } }],
    });
    expect(withNulls).toEqual(withZeros);
  });

  it("reads null results and a null state as Go's zero values, then refuses them", () => {
    const parsed = normalizeInput({ state: null, results: null });
    expect(parsed.results).toEqual([]);
    expect(parsed.state.project_id).toBe("");
    expect(errorOf({ state: null, results: null })).toContain("state.project_id is empty");
    expect(errorOf(null)).toContain("state.project_id is empty");
  });

  it("refuses a field of the wrong type, naming it", () => {
    expect(errorOf({ state: { project_id: 7 } })).toContain("state.project_id must be a string");
    expect(errorOf({ state: { project_id: "p", obligations: {} } })).toContain("state.obligations must be an array");
    expect(errorOf({ state: { project_id: "p", rev: 1.5 } })).toContain("state.rev must be an integer");
    expect(errorOf({ state: { project_id: "p" }, results: [{ execution_completed: "yes" }] })).toContain("execution_completed must be a boolean");
  });
});

describe("the tool", () => {
  const chain: Record<string, unknown> = new Proxy(() => chain, {
    get: (_target, key) => (key === "then" ? undefined : chain),
    apply: () => chain,
  }) as never;
  const zod = new Proxy({}, { get: () => () => chain }) as never;
  const tool = factory({ zod } as never) as unknown as {
    execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Reconciliation }>;
  };

  it("returns the reconciliation as text and as details", async () => {
    const result = await tool.execute("id", inputWith("satisfied-preserves-unaffected"));
    expect(result.details.changes).toEqual([{ action: "satisfy", id: "a", evidence: "go test ok" }]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("throws on a refused call rather than returning a failure as success", async () => {
    await expect(tool.execute("id", { state: { project_id: "p" }, results: [] })).rejects.toThrow("results is empty");
  });
});
