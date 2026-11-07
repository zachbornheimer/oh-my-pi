/**
 * The top-level scalar keys of a `SKILL.md` frontmatter block, as strings. Handles plain, quoted and folded/literal
 * (`>`, `>-`, `|`, `|-`) scalars, and a plain or quoted scalar continued on indented lines. Nested maps and lists are
 * skipped. Returns undefined when the file has no frontmatter block.
 */
export function parseFrontmatter(text: string): Record<string, string> | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return undefined;
  const body = lines.slice(1, end);
  const result: Record<string, string> = {};
  let index = 0;
  while (index < body.length) {
    const head = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/.exec(body[index]!);
    if (head === null) {
      index += 1;
      continue;
    }
    const key = head[1]!;
    const first = (head[2] ?? "").trimEnd();
    index += 1;
    const continuation: string[] = [];
    while (index < body.length && (body[index]!.trim() === "" || /^\s/.test(body[index]!))) {
      continuation.push(body[index]!);
      index += 1;
    }
    while (continuation.length > 0 && continuation[continuation.length - 1]!.trim() === "") continuation.pop();
    result[key] = scalar(first, continuation);
  }
  return result;
}

function scalar(first: string, continuation: string[]): string {
  const block = /^([>|])([+-]?)\d*\s*(?:#.*)?$/.exec(first);
  if (block !== null) {
    const indent = Math.min(...continuation.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length), Infinity);
    const stripped = continuation.map((line) => (line.trim() === "" ? "" : line.slice(Number.isFinite(indent) ? indent : 0)));
    if (block[1] === "|") return stripped.join("\n").trim();
    // Folded: single newlines become spaces, blank lines become newlines.
    return stripped
      .join("\n")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.split("\n").join(" "))
      .join("\n")
      .trim();
  }
  const joined = [first, ...continuation.map((line) => line.trim())].filter((part) => part !== "").join(" ");
  if (joined.startsWith('"') && joined.endsWith('"') && joined.length >= 2) {
    try {
      return JSON.parse(joined) as string;
    } catch {
      return joined.slice(1, -1);
    }
  }
  if (joined.startsWith("'") && joined.endsWith("'") && joined.length >= 2) return joined.slice(1, -1).replaceAll("''", "'");
  return joined;
}
