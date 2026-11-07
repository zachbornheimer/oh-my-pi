/** Edits to an existing file that only add lines: the shape of a registry edit. */

export interface Insertion {
  /** An existing line (exact text); the new lines go right after it. */
  readonly after: string;
  readonly lines: readonly string[];
}

const CONTEXT_LINES = 3;

interface LineText {
  readonly lines: string[];
  readonly endsWithNewline: boolean;
}

function splitLines(text: string): LineText {
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, endsWithNewline };
}

const joinLines = ({ lines, endsWithNewline }: LineText): string => lines.join("\n") + (endsWithNewline ? "\n" : "");

export interface InsertionResult {
  readonly text?: string;
  /** Why the insertions cannot be made, written for the model that wrote them. */
  readonly problem?: string;
}

/** `text` with each insertion made after its anchor line. An anchor must match exactly one line. */
export function applyInsertions(text: string, insertions: readonly Insertion[]): InsertionResult {
  if (insertions.length === 0) return { problem: "give at least one insertion" };
  const original = splitLines(text);
  const additionsAfter = new Map<number, string[]>();
  for (const insertion of insertions) {
    if (insertion.lines.length === 0) return { problem: `the insertion after "${insertion.after}" has no lines` };
    const matches = original.lines.flatMap((line, index) => (line === insertion.after ? [index] : []));
    if (matches.length !== 1) {
      const why = matches.length === 0 ? "matches no line of the file" : `matches ${matches.length} lines`;
      return { problem: `"after" must be one existing line copied exactly, but "${insertion.after}" ${why}` };
    }
    additionsAfter.set(matches[0]!, [...(additionsAfter.get(matches[0]!) ?? []), ...insertion.lines]);
  }
  const lines = original.lines.flatMap((line, index) => [line, ...(additionsAfter.get(index) ?? [])]);
  return { text: joinLines({ lines, endsWithNewline: original.endsWithNewline }) };
}

interface Operation {
  readonly added: boolean;
  readonly line: string;
}

/** The lines of `after` marked as kept from `before` or added, or undefined when `after` is not `before` plus lines. */
function alignAdditions(before: readonly string[], after: readonly string[]): Operation[] | undefined {
  const operations: Operation[] = [];
  let kept = 0;
  for (const line of after) {
    const keep = kept < before.length && before[kept] === line;
    operations.push({ added: !keep, line });
    if (keep) kept += 1;
  }
  return kept === before.length ? operations : undefined;
}

function hunkRanges(operations: readonly Operation[]): [number, number][] {
  const ranges: [number, number][] = [];
  operations.forEach((operation, index) => {
    if (!operation.added) return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(operations.length, index + CONTEXT_LINES + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = to;
    else ranges.push([from, to]);
  });
  return ranges;
}

function formatHunk(operations: readonly Operation[], from: number, to: number): string {
  const slice = operations.slice(from, to);
  const oldBefore = operations.slice(0, from).filter((operation) => !operation.added).length;
  const newBefore = from;
  const oldCount = slice.filter((operation) => !operation.added).length;
  const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
  const header = `@@ -${oldStart},${oldCount} +${newBefore + 1},${slice.length} @@`;
  return [header, ...slice.map((operation) => `${operation.added ? "+" : " "}${operation.line}`)].join("\n");
}

/**
 * The unified diff from `before` to `after` for `path`, or undefined when `after` is not `before` with lines added
 * (a removed or changed line, or a different final newline).
 */
export function additionDiff(path: string, before: string, after: string): string | undefined {
  const old = splitLines(before);
  const next = splitLines(after);
  if (old.endsWithNewline !== next.endsWithNewline) return undefined;
  const operations = alignAdditions(old.lines, next.lines);
  if (operations === undefined) return undefined;
  const hunks = hunkRanges(operations).map(([from, to]) => formatHunk(operations, from, to));
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n") + "\n";
}
