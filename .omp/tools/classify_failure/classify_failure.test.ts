import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyFailure, type FailureClassification } from "./classify.ts";
import factory from "./index.ts";

interface Case {
  id: string;
  source: string;
  input: Parameters<typeof classifyFailure>[0];
  expected: { result: FailureClassification } | { error: string };
}

const cases = JSON.parse(readFileSync(new URL("./fixtures/cases.json", import.meta.url), "utf8")) as Case[];

describe("agentmux parity fixtures, verbatim", () => {
  for (const fixture of cases) {
    it(fixture.id, () => {
      if ("error" in fixture.expected) {
        expect(() => classifyFailure(fixture.input)).toThrow(fixture.expected.error);
        return;
      }
      expect(classifyFailure(fixture.input)).toEqual(fixture.expected.result);
    });
  }

  it("covers every Go test that classifies", () => {
    expect(cases.length).toBeGreaterThanOrEqual(24);
    expect(new Set(cases.map((fixture) => fixture.source))).toContain("TestClassifyFailureClasses");
  });
});

describe("classification", () => {
  it("walks the whole implementation ladder when each answer is recorded as history", () => {
    const outcome = { status: "failed", criteria: [{ criterion: "a", status: "failed" }] };
    const history: { signature: string; action: string }[] = [];
    const seen: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = classifyFailure({ outcome, history });
      seen.push(result.next_action);
      history.push({ signature: result.signature, action: result.next_action });
    }
    expect(seen).toEqual(["retry_with_failure_evidence", "escalate", "request_human", "request_human", "request_human"]);
  });

  it("treats missing fields as empty and applies defaults", () => {
    const result = classifyFailure({ outcome: { status: "failed" } });
    expect(result.class).toBe("implementation");
    expect(result.next_action).toBe("retry_with_failure_evidence");
    const nulls = classifyFailure({ outcome: { status: "failed", criteria: null }, history: null, environment_fixed: null });
    expect(nulls).toEqual(result);
  });

  it("FIXED: a status named like an Object.prototype member is unknown, not a class", () => {
    for (const status of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => classifyFailure({ outcome: { status } })).toThrow(`unknown verification status "${status}"`);
    }
  });

  it("rejects an outcome with no status as unknown", () => {
    expect(() => classifyFailure({})).toThrow('unknown verification status ""');
  });

  it("rejects non-string fields explicitly", () => {
    expect(() => classifyFailure({ outcome: { status: 3 as unknown as string } })).toThrow("outcome.status must be a string");
    expect(() =>
      classifyFailure({ outcome: { status: "failed", criteria: [{ reason: 7 as unknown as string }] } }),
    ).toThrow("criteria[0].reason must be a string");
  });

  it("ignores history entries for other signatures", () => {
    const outcome = { status: "failed", criteria: [{ criterion: "a", status: "failed" }] };
    const result = classifyFailure({ outcome, history: [{ signature: "other", action: "retry_with_failure_evidence" }] });
    expect(result.next_action).toBe("retry_with_failure_evidence");
  });
});

/** A chainable stand-in for `pi.zod`: every method returns the same proxy. */
function fakeZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}

interface BuiltTool {
  name: string;
  description: string;
  loadMode?: unknown;
  execute(id: string, params: unknown): Promise<{ content: { text: string }[]; details: FailureClassification }>;
}
const buildTool = (pi: { zod: unknown }): BuiltTool => (factory as unknown as (pi: unknown) => BuiltTool)(pi);

describe("tool object", () => {
  it("builds a named, discoverable tool whose execute returns text and typed details", async () => {
    const tool = buildTool({ zod: fakeZod() });
    expect(tool.name).toBe("classify_failure");
    expect(tool.loadMode).toBeUndefined();
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    const out = await tool.execute("id", { outcome: { status: "indeterminate", criteria: [{ criterion: "c", status: "indeterminate", reason: "missing_evidence" }] } });
    expect(out.details.class).toBe("evidence");
    expect(out.details.next_action).toBe("request_context");
    expect(out.content[0].text).toContain("next_action: request_context");
  });

  it("fails by throwing for a satisfied outcome", async () => {
    const tool = buildTool({ zod: fakeZod() });
    await expect(tool.execute("id", { outcome: { status: "satisfied" } })).rejects.toThrow("no failure to classify");
  });
});
