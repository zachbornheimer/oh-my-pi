import type { File, Hunk, HunkKind, TestDiffFact } from "./schemas.js";

// Port of agentmux internal/depupgrade/testdiff.go: removed assertions and added skips in the changed
// test files' patches.

/** assertionTokens mark a line that asserts behavior. */
const ASSERTION_TOKENS = [
  "expect(",
  "assert",
  "toBe",
  "toEqual",
  "toThrow",
  "t.Error",
  "t.Fatal",
  "require.",
  "should",
];

/** skipTokens mark a line that turns a test off. */
const SKIP_TOKENS = [".skip(", "xit(", "xdescribe(", "t.Skip"];

function containsAny(line: string, tokens: string[]): boolean {
  return tokens.some((token) => line.includes(token));
}

function suspiciousLines(file: File): Hunk[] {
  const out: Hunk[] = [];
  for (const line of (file.patch ?? "").split("\n")) {
    let kind: HunkKind | undefined;
    if (line.startsWith("-") && !line.startsWith("---") && containsAny(line, ASSERTION_TOKENS)) {
      kind = "removed_assertion";
    } else if (line.startsWith("+") && !line.startsWith("+++") && containsAny(line, SKIP_TOKENS)) {
      kind = "added_skip";
    }
    if (kind !== undefined) out.push({ path: file.path ?? "", kind, line: line.slice(1).trim() });
  }
  return out;
}

/** DiffTests scans the patch of every changed test file for removed assertions and added skips. */
export function DiffTests(files: File[]): TestDiffFact {
  const fact: TestDiffFact = { changed: [], suspicious: [] };
  for (const file of files) {
    if (!file.test) continue;
    fact.changed.push(file.path ?? "");
    fact.suspicious.push(...suspiciousLines(file));
  }
  return fact;
}
