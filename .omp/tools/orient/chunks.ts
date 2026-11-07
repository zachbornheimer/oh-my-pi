/**
 * A source file cut into the ranges orient retrieves and judges: one chunk per declaration where the file has them, so
 * a function, its doc comment and its body travel together, and no chunk is longer than a reader can judge at once.
 * Pure.
 */

/** A 1-based inclusive line range of one file. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** No chunk is longer than this; a longer declaration is cut into pieces of this size. */
export const MAX_CHUNK_LINES = 60;
/** A declaration shorter than this joins the chunk before it, so a run of one-line constants is one chunk. */
const MIN_CHUNK_LINES = 15;

/** A line that opens a declaration in the languages this repository's agents work in, at module or class depth. */
const DECLARATION =
  /^\s{0,4}(?:(?:export|pub(?:\([^)]*\))?|async|public|private|protected|static|default|abstract|override|unsafe)\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl|fn|def|func|const|let|var|module|namespace|mod)\b/;
/** A line that belongs to the declaration below it: a comment, a decorator or an attribute. */
const LEADING = /^\s*(?:\/\/|\/\*|\*|#\[|#!\[|@[A-Za-z]|#\s|--\s)/;
/** A top-level line that starts something new: not blank, not indented, not a closing bracket. */
const TOP_LEVEL = /^[^\s})\]]/;

function opensDeclaration(line: string): boolean {
  return DECLARATION.test(line) || (TOP_LEVEL.test(line) && !LEADING.test(line));
}

/** Where a cut before line `at` (0-based) really goes: above the comments and attributes that lead into it. */
function cutAbove(lines: readonly string[], at: number, floor: number): number {
  let cut = at;
  while (cut - 1 > floor && LEADING.test(lines[cut - 1] ?? "")) cut -= 1;
  return cut;
}

/** The file's chunks, in order, covering every line once. A file with no lines has none. */
export function chunkRanges(text: string): LineRange[] {
  const lines = text.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const ranges: LineRange[] = [];
  let start = 0;
  for (let at = 1; at < lines.length; at += 1) {
    const length = at - start;
    if (length >= MAX_CHUNK_LINES) {
      ranges.push({ start: start + 1, end: at });
      start = at;
    } else if (length >= MIN_CHUNK_LINES && opensDeclaration(lines[at] ?? "")) {
      const cut = cutAbove(lines, at, start + MIN_CHUNK_LINES - 1);
      ranges.push({ start: start + 1, end: cut });
      start = cut;
    }
  }
  ranges.push({ start: start + 1, end: lines.length });
  return ranges;
}
