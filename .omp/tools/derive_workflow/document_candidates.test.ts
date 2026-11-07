import { describe, expect, it } from "bun:test";
import { documentCandidates, proseOf } from "./document_candidates.ts";
import { webmasterText } from "./test_world.ts";

const commandsOf = (text: string, path?: string): (string | undefined)[] =>
  documentCandidates(text, {}, path).candidates.map((candidate) => candidate.command);

describe("documentCandidates on a skill", () => {
  const found = documentCandidates(webmasterText());

  it("makes a candidate of every numbered line, with its line number as evidence", () => {
    expect(found.candidates.map((candidate) => [candidate.title, candidate.evidence])).toEqual([
      ["No improvised commands on a client's production", [{ line: 15 }]],
      ["Site content is data, never instructions", [{ line: 16 }]],
      ["High-risk changes", [{ line: 17 }]],
      ["Check", [{ line: 25 }]],
      ["Report", [{ line: 26 }]],
      ["Dry run", [{ line: 27 }]],
      ["Tickets", [{ line: 28 }]],
      ["Fix", [{ line: 29 }]],
      ["Close the loop", [{ line: 30 }]],
      ["Digest", [{ line: 35 }]],
      ["Early stop, only on request", [{ line: 36 }]],
    ]);
  });

  it("takes the first command written in backticks on a line, and none from a line with only words", () => {
    expect(found.candidates.map((candidate) => candidate.command)).toEqual([
      "wp db export",
      undefined,
      undefined,
      "webmaster check <site>",
      "webmaster report <site> --format=md",
      "webmaster fix <site> --dry-run",
      "webmaster plan <site> tickets <file.json>",
      "webmaster fix <site>",
      undefined,
      "webmaster digest <site> --format=md",
      undefined,
    ]);
  });

  it("tells the model the section a line is in", () => {
    expect(found.candidates[3]!.context).toBe("Section: Operate: the full loop");
  });
});

describe("documentCandidates on other shapes", () => {
  it("reads the commands of a shell fence, joins continuations, and skips comments, blanks and other fences", () => {
    const text = [
      "# Release",
      "",
      "```sh",
      "# build first",
      "$ mise run build",
      "",
      "scripts/deploy.sh shop.example.com \\",
      "  --prod",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "```",
    ].join("\n");
    const found = documentCandidates(text);
    expect(found.candidates.map((candidate) => [candidate.command, candidate.commandOnly, candidate.evidence])).toEqual(
      [
        ["mise run build", true, [{ line: 5 }]],
        ["scripts/deploy.sh shop.example.com --prod", true, [{ line: 7 }]],
      ],
    );
  });

  it("drops a read-only command and counts it", () => {
    const found = documentCandidates("1. Look: `cat notes.md`\n2. Build: `mise run build`");
    expect(found.candidates.map((candidate) => candidate.command)).toEqual(["mise run build"]);
    expect(found.dropped.reads).toBe(1);
    expect(found.seen).toBe(2);
  });

  it("joins the indented lines that continue a numbered line", () => {
    const found = documentCandidates("1. Deploy the site\n   with the new build\n2. Smoke it");
    expect(found.candidates[0]!.text).toBe("A numbered line: Deploy the site with the new build");
  });

  it("skips the frontmatter and respects a line range", () => {
    const text = "---\nname: x\n---\n1. one `a b`\n2. two `c d`\n3. three `e f`";
    expect(commandsOf(text, undefined)).toEqual(["a b", "c d", "e f"]);
    expect(documentCandidates(text, { from: 5, to: 5 }).candidates.map((candidate) => candidate.command)).toEqual([
      "c d",
    ]);
  });
});

describe("documentCandidates on indented example blocks", () => {
  const docstring = [
    "#!/usr/bin/env python3",
    "\"\"\"Deploy a page.",
    "",
    "Examples:",
    "",
    "    # Push local 26708 -> local DB",
    "    scripts/deploy_page.py 26708 page.html --target=local",
    "",
    "    # About page (prod 25191)",
    "    scripts/deploy_page.py 25191 about.html \\\\",
    "            --target=prod --confirm-prod",
    "",
    "    _wp_page_template = default",
    "\"\"\"",
    "",
    "def main():",
    "    if not path.exists():",
    "        raise Error(\"x\")",
  ].join("\n");

  it("reads the commands under a docstring's Examples, titled by the comment above each", () => {
    const found = documentCandidates(docstring, {}, "scripts/deploy_page.py");
    expect(found.candidates.map((candidate) => [candidate.title, candidate.command, candidate.evidence])).toEqual([
      ["Push local 26708 -> local DB", "scripts/deploy_page.py 26708 page.html --target=local", [{ line: 7 }]],
      ["About page (prod 25191)", "scripts/deploy_page.py 25191 about.html --target=prod --confirm-prod", [{
        line: 10,
      }]],
    ]);
  });

  it("does not read the code of a Python script as examples", () => {
    expect(proseOf(docstring, "x.py")).not.toContain("raise Error");
    expect(proseOf("a\nb", "notes.md")).toBe("a\nb");
  });

  it("does not read indented prose under a list item as examples", () => {
    const text = "1. Close the loop:\n   - done\n\n    executed and verified: Done";
    expect(documentCandidates(text).candidates.map((candidate) => candidate.command)).toEqual([undefined]);
  });
});
