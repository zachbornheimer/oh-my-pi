import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type ChangeQualityAssessment, assessChangeQuality, normalizeInput } from "./assess.js";
import factory from "./index.js";

/**
 * The fixtures are the Mastra twin's parity cases: inputs written as JSON and the verbatim output of the real Go binary
 * (`agentmux capability run assess_change_quality`), never computed in TypeScript.
 */
interface Case {
  id: string;
  source: string;
  input: unknown;
  expected: { result: ChangeQualityAssessment };
}

const cases = JSON.parse(readFileSync(new URL("./fixture_cases.json", import.meta.url), "utf8")) as Case[];

const assess = (input: unknown): ChangeQualityAssessment => assessChangeQuality(normalizeInput(input));

describe("parity fixtures, verbatim", () => {
  it.each(cases.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    const output = assess(fixture.input);
    expect(output).toEqual(fixture.expected.result);
    expect(JSON.stringify(output)).toBe(JSON.stringify(fixture.expected.result));
  });

  it("covers each Go test that assesses", () => {
    const sources = new Set(cases.map((fixture) => fixture.source));
    for (const test of [
      "TestAssessChangeQualityReportsEvidenceWithScope",
      "TestAssessChangeQualityThresholdIsNotADefect",
      "TestAssessChangeQualityEmptyInputIsDeterministicAndClaimsNothing",
      "TestAssessChangeQualityRepeatedConsumerMotifNamesConsumersWithoutJudging",
      "TestAssessChangeQualityMotifBelowThresholdIsQuiet",
      "TestAssessChangeQualityFacadeBypassNamesBypassingConsumer",
      "TestAssessChangeQualityDuplicatePathStaysDistinctFromConsumerMotif",
      "TestAssessChangeQualityWithoutReviewerLeavesRequestUnresolved",
      "TestAssessChangeQualityQuietInputsRequestNoReview",
      "TestAssessChangeQualityGivesReviewerPurposeAndHunk",
      "TestBoundedHunkTruncatesLongHunks",
    ]) {
      expect(sources).toContain(test);
    }
    expect(cases.length).toBe(30);
  });
});

describe("input handling", () => {
  it("reads null lists, strings, objects and counts as empty, as the Go original did", () => {
    const withNulls = normalizeInput({
      purpose: null,
      files: [{ path: "a.ts", hunks: null, lines: null, timeout_changes: null, assertions: { before: null, after: 2 } }],
      duplicate_paths: null,
      consumers: [{ consumer: null, motif: null }],
      thresholds: null,
    });
    const withZeros = normalizeInput({
      purpose: "",
      files: [{ path: "a.ts", hunks: "", lines: {}, timeout_changes: [], assertions: { before: 0, after: 2 } }],
      duplicate_paths: [],
      consumers: [{ consumer: "", motif: "" }],
      thresholds: {},
    });
    expect(withNulls).toEqual(withZeros);
  });

  it("answers an empty call with the basis, not an error", () => {
    for (const input of [{}, undefined, null]) {
      expect(assess(input)).toEqual({
        files_examined: 0,
        findings: [],
        deeper_review: false,
        basis: "deterministic signals from the supplied change description; review-triage evidence only",
      });
    }
  });

  it.each([
    [[], "the call: expected an object"],
    [{ files: "a" }, "files: expected an array"],
    [{ files: [null] }, "files[0]: expected an object"],
    [{ files: [{ path: 3 }] }, "files[0].path: expected a string"],
    [{ files: [{ lines: { before: 1.5 } }] }, "files[0].lines.before: expected an integer"],
    [{ files: [{ lines: [] }] }, "files[0].lines: expected an object"],
    [{ files: [{ test: "yes" }] }, "files[0].test: expected true or false"],
    [{ files: [{ timeout_changes: [{ to_seconds: "9" }] }] }, "files[0].timeout_changes[0].to_seconds: expected a number"],
    [{ thresholds: { lines: "big" } }, "thresholds.lines: expected an integer"],
    [{ consumers: [{ bypassed_facade: 1 }] }, "consumers[0].bypassed_facade: expected true or false"],
  ])("refuses a wrongly typed field %j", (input, message) => {
    expect(() => assess(input)).toThrow(`invalid input for assess_change_quality: ${message}`);
  });
});

describe("signals", () => {
  const grown = (after: number, extra: Record<string, unknown> = {}) => ({
    files: [{ path: "a.ts", lines: { before: 0, after }, ...extra }],
  });

  it("raises a note at the threshold and a review at twice it, and nothing below", () => {
    expect(assess(grown(149)).findings).toEqual([]);
    expect(assess(grown(150)).findings[0]).toMatchObject({ kind: "file_growth", triage: "note", deeper_review: false });
    expect(assess(grown(299)).findings[0]).toMatchObject({ triage: "note" });
    expect(assess(grown(300)).findings[0]).toMatchObject({ triage: "review", deeper_review: true });
  });

  it("takes a zero or negative threshold as the default and a positive one as given", () => {
    expect(assess({ ...grown(10), thresholds: { lines: 0 } }).findings).toEqual([]);
    expect(assess({ ...grown(10), thresholds: { lines: -5 } }).findings).toEqual([]);
    expect(assess({ ...grown(10), thresholds: { lines: 10 } }).findings).toHaveLength(1);
  });

  it("applies assertion and skip-marker rules to test files only", () => {
    const measures = { assertions: { before: 3, after: 1 }, skip_markers: { before: 0, after: 1 } };
    expect(assess({ files: [{ path: "a.ts", ...measures }] }).findings).toEqual([]);
    const kinds = assess({ files: [{ path: "a_test.ts", test: true, ...measures }] }).findings.map((f) => f.kind);
    expect(kinds).toEqual(["assertion_reduction", "skipped_test_added"]);
  });

  it("flags only a widened timeout, quoting its name and formatting seconds like Go", () => {
    const output = assess({
      files: [
        {
          path: "a.ts",
          timeout_changes: [
            { name: "narrowed", from_seconds: 10, to_seconds: 5 },
            { name: "wide \"x\"", from_seconds: 0.5, to_seconds: 1e7 },
          ],
        },
      ],
    });
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.evidence).toBe('timeout "wide \\"x\\"" widened from 0.5s to 1e+07s');
  });

  it("orders findings by file, then duplicate paths, then motifs, then facade bypasses", () => {
    const output = assess({
      files: [{ path: "a.ts", lines: { before: 0, after: 150 } }],
      duplicate_paths: [{ old: "o", new: "n" }],
      consumers: [
        { consumer: "z", motif: " m ", bypassed_facade: true },
        { consumer: "b", motif: "m" },
        { consumer: "a", motif: "m" },
      ],
    });
    expect(output.findings.map((finding) => finding.kind)).toEqual([
      "file_growth",
      "duplicate_path",
      "repeated_consumer_motif",
      "facade_bypass",
    ]);
    expect(output.findings[2]!.consumers).toEqual(["a", "b", "z"]);
    expect(output.findings[3]!.evidence).toBe('consumer "z" bypassed intended facade (intended facade not named)');
  });

  it("does not count the same consumer twice toward a motif", () => {
    const consumers = [1, 2, 3].map(() => ({ consumer: "same", motif: "m" }));
    expect(assess({ consumers }).findings).toEqual([]);
  });
});

describe("the review request", () => {
  it("is absent when nothing asks for deeper review", () => {
    expect(assess({ files: [{ path: "a.ts", lines: { before: 0, after: 150 } }] }).review).toBeUndefined();
  });

  it("is always unresolved, carries the purpose and each flagged file's hunk bounded to 4000 bytes", () => {
    const hunks = `${"é".repeat(3000)}`;
    const output = assess({
      purpose: "Add retry",
      files: [{ path: "a_test.ts", test: true, assertions: { before: 2, after: 0 }, hunks }],
    });
    expect(output.deeper_review).toBe(true);
    expect(output.review?.status).toBe("unresolved");
    expect(output.review?.request.purpose).toBe("Add retry");
    expect(output.review?.request.options.map((option) => option.id)).toEqual([
      "explained_by_change_purpose",
      "needs_human_attention",
      "cannot_determine",
    ]);
    const hunk = output.review!.request.findings[0]!.hunk!;
    expect(hunk.endsWith("\n... (hunk truncated)")).toBe(true);
    expect(Buffer.byteLength(hunk.replace("\n... (hunk truncated)", ""))).toBeLessThanOrEqual(4000);
    expect(output.findings[0]).not.toHaveProperty("hunk");
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
  it("is named assess_change_quality and describes itself in 80 to 250 words", () => {
    expect(tool.name).toBe("assess_change_quality");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("returns the assessment as text and as details", async () => {
    const result = await tool.execute("id", { files: [{ path: "a.ts", lines: { before: 0, after: 150 } }] });
    expect(result.details).toMatchObject({ files_examined: 1, findings: [{ kind: "file_growth" }] });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("throws on a wrongly typed field instead of guessing", async () => {
    await expect(tool.execute("id", { files: "a.ts" })).rejects.toThrow("files: expected an array");
  });
});
