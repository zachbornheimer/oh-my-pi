import { describe, expect, it } from "bun:test";
import { outlineCandidates, outlineProblem } from "./outline.ts";

const TEXT = [
  "# Release",
  "We build the package,",
  "then run the smoke gate, which must pass.",
  "After the gate passes the tag is pushed.",
].join("\n");

describe("outline", () => {
  it("accepts steps whose quotes are on a line of the text, ignoring whitespace", () => {
    expect(outlineProblem(TEXT, [{ title: "Gate", quote: "run the  smoke gate" }])).toBeUndefined();
  });

  it("refuses an empty outline and a quote that is not in the text, saying which", () => {
    expect(outlineProblem(TEXT, [])).toBe("list at least one step");
    expect(outlineProblem(TEXT, [{ title: "A", quote: "We build" }, { title: "B", quote: "invented words" }]))
      .toContain(
        "the quote of step 2 (\"invented words\")",
      );
    expect(outlineProblem(TEXT, [{ title: "A", quote: "package, then run" }])).toContain("step 1");
  });

  it("makes candidates anchored to the quote's line, in the text's order", () => {
    const found = outlineCandidates(TEXT, [
      { title: "Pass the smoke gate.", quote: "run the smoke gate" },
      { title: "Push the tag", quote: "the tag is pushed" },
      { title: "Build", quote: "We build the package" },
    ]);
    expect(found.candidates.map((candidate) => [candidate.id, candidate.title, candidate.evidence])).toEqual([
      ["c1", "Pass the smoke gate", [{ line: 3 }]],
      ["c2", "Push the tag", [{ line: 4 }]],
      ["c3", "Build", [{ line: 2 }]],
    ]);
    expect(found.candidates[0]!.text).toBe("A step the document describes: run the smoke gate");
    expect(found.seen).toBe(3);
  });
});
