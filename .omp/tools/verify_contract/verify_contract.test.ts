import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import factory from "./index.js";
import { normalizeInput, type VerificationOutcome, verifyContract } from "./verify.js";

/**
 * The fixtures are the Mastra twin's own parity cases: inputs written as JSON and the verbatim output of the real Go
 * binary (`agentmux capability run verify_contract`), so each case is a behavior the original is known to have.
 */
interface Case {
  id: string;
  source: string;
  input: unknown;
  expected: { result: VerificationOutcome } | { error: string };
}

const cases = JSON.parse(readFileSync(new URL("./fixture_cases.json", import.meta.url), "utf8")) as Case[];

const verify = (input: unknown): VerificationOutcome => verifyContract(normalizeInput(input));

describe("parity fixtures, verbatim", () => {
  it.each(cases.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    if ("error" in fixture.expected) {
      expect(() => verify(fixture.input)).toThrow(fixture.expected.error);
      return;
    }
    const output = verify(fixture.input);
    expect(output).toEqual(fixture.expected.result);
    expect(JSON.stringify(output)).toBe(JSON.stringify(fixture.expected.result));
  });

  it("covers each Go test that verifies a contract", () => {
    const sources = new Set(cases.map((fixture) => fixture.source));
    for (const name of [
      "TestVerifyContractCriterionOutcomes",
      "TestVerifyContractFoldsFailureOverEnvironmentOverIndeterminate",
      "TestVerifyContractRejectsUnverifiableInput",
      "TestVerifyContractIgnoresExecutionClaim",
      "TestVerifyContractIndeterminateWhenIntendedTestPassesOnKnownBadBasis",
    ]) {
      expect(sources).toContain(name);
    }
    expect(cases.length).toBeGreaterThanOrEqual(43);
  });
});

describe("input handling", () => {
  it("reads null lists and strings as empty, as the Go original did", () => {
    const withNulls = normalizeInput({
      contract: null,
      criteria: [{ id: "c1", description: null, min_strength: null }],
      evidence: null,
      execution_completed: null,
    });
    expect(withNulls).toEqual(
      normalizeInput({ contract: "", criteria: [{ id: "c1", description: "", min_strength: "" }], evidence: [] }),
    );
  });

  it("does not let an execution claim stand in for evidence", () => {
    const output = verify({ contract: "c", criteria: [{ id: "a" }], execution_completed: true });
    expect(output.status).toBe("indeterminate");
    expect(output.criteria[0]?.reason).toBe("missing_evidence");
  });

  it("reports a missing call as the tool's own error: no criteria", () => {
    expect(() => verify({})).toThrow('verify_contract: contract "" declares no criteria');
    expect(() => verify(undefined)).toThrow('declares no criteria');
  });

  it.each([
    [{ contract: 3 }, "contract: expected a string"],
    [{ criteria: "a" }, "criteria: expected an array"],
    [{ criteria: ["a"] }, "criteria[0]: expected an object"],
    [{ criteria: [{ id: 1 }] }, "criteria[0].id: expected a string"],
    [{ criteria: [{ id: "a" }], evidence: [{ passes_on_known_bad_basis: "yes" }] }, "evidence[0].passes_on_known_bad_basis: expected true or false"],
    [{ execution_completed: "done" }, "execution_completed: expected true or false"],
    [[], "the call: expected an object"],
  ])("refuses a wrongly typed field %j", (input, message) => {
    expect(() => verify(input)).toThrow(`invalid input for verify_contract: ${message}`);
  });
});

describe("verdicts", () => {
  const evidence = (result: string, extra: Record<string, unknown> = {}) => ({
    criterion: "a",
    source: "check",
    result,
    detail: "why",
    ...extra,
  });

  it("folds a failure over a verifier failure over an undecided criterion over satisfied", () => {
    const criteria = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const folded = (observations: { criterion: string; source: string; result: string; detail?: string }[]) =>
      verify({ contract: "c", criteria, evidence: observations }).status;
    const pass = (criterion: string) => ({ criterion, source: "s", result: "pass" });
    expect(folded([pass("a"), pass("b"), pass("c")])).toBe("satisfied");
    expect(folded([pass("a"), pass("b")])).toBe("indeterminate");
    expect(folded([pass("a"), { criterion: "b", source: "s", result: "verifier_error" }])).toBe("verifier_failure");
    expect(folded([{ criterion: "c", source: "s", result: "fail", detail: "x" }, { criterion: "b", source: "s", result: "verifier_error" }])).toBe("failed");
  });

  it("makes a weak pass insufficient only for a strong minimum", () => {
    const weakPass = evidence("pass", { strength: "weak" });
    expect(verify({ contract: "c", criteria: [{ id: "a", min_strength: "strong" }], evidence: [weakPass] }).criteria[0]).toMatchObject({
      status: "indeterminate",
      reason: "insufficient_strength",
    });
    expect(verify({ contract: "c", criteria: [{ id: "a" }], evidence: [weakPass] }).status).toBe("satisfied");
  });

  it("does not count a pass that also passes on a known-bad basis", () => {
    const output = verify({ contract: "c", criteria: [{ id: "a" }], evidence: [evidence("pass", { passes_on_known_bad_basis: true })] });
    expect(output.criteria[0]).toMatchObject({ status: "indeterminate", reason: "non_discriminating" });
  });

  it("keeps the sources and the failing details in evidence order", () => {
    const output = verify({
      contract: "c",
      criteria: [{ id: "a" }],
      evidence: [evidence("fail", { source: "one", detail: "first" }), evidence("fail", { source: "two", detail: "second" })],
    });
    expect(output.criteria[0]).toEqual({ criterion: "a", status: "failed", sources: ["one", "two"], details: ["first", "second"] });
  });
});

/** A stand-in for `pi.zod`: every method chains, which is all the factory needs to build its schema. */
const chain: unknown = new Proxy(function () {}, { get: () => chain, apply: () => chain });
type Pi = Parameters<CustomToolFactory>[0];

interface Tool {
  name: string;
  description: string;
  execute(id: string, params: unknown): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}
const tool = factory({ zod: chain } as unknown as Pi) as unknown as Tool;

describe("the tool", () => {
  it("is named verify_contract and describes itself in 80 to 250 words", () => {
    expect(tool.name).toBe("verify_contract");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("returns the outcome as text and as details", async () => {
    const result = await tool.execute("id", {
      contract: "c",
      criteria: [{ id: "a" }],
      evidence: [{ criterion: "a", source: "s", result: "pass" }],
    });
    expect(result.details).toEqual({ status: "satisfied", criteria: [{ criterion: "a", status: "satisfied", sources: ["s"] }] });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("throws rather than answering when the evidence is unusable", async () => {
    await expect(tool.execute("id", { contract: "c", criteria: [{ id: "a" }], evidence: [{ criterion: "a", source: "s", result: "fail" }] })).rejects.toThrow(
      "needs detail to be actionable",
    );
  });
});
