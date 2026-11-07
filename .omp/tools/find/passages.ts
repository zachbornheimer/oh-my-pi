import type { Passage } from "./schemas.js";

/**
 * The passage half of `find`: cut a file into overlapping windows, keep the ones that carry
 * the query's terms, and reduce each to a few verbatim lines the judge can read quickly.
 */

const WINDOW_LINES = 40;
const STRIDE_LINES = 20;
const PASSAGES_PER_FILE = 2;
const SKETCH_LINES = 3;
const SKETCH_LINE_CHARACTERS = 200;

function termsIn(line: string, terms: readonly string[]): number {
  const lower = line.toLowerCase();
  return terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
}

function sketchOf(lines: readonly string[], terms: readonly string[]): string {
  return lines
    .map((line, index) => ({ line: line.trim(), index, hits: termsIn(line, terms) }))
    .filter((entry) => entry.line !== "")
    .sort((one, other) => other.hits - one.hits || one.index - other.index)
    .slice(0, SKETCH_LINES)
    .sort((one, other) => one.index - other.index)
    .map((entry) => entry.line.slice(0, SKETCH_LINE_CHARACTERS))
    .join("\n");
}

/** Up to two windows, ordered by position, each with its densest lines as a sketch. */
export function passagesOf(text: string, terms: readonly string[]): Passage[] {
  const lines = text.split("\n");
  const windows: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start < lines.length; start += STRIDE_LINES) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    const slice = lines.slice(start, end);
    windows.push({ start, end, score: slice.reduce((total, line) => total + termsIn(line, terms), 0) });
    if (end === lines.length) break;
  }
  return windows
    .sort((one, other) => other.score - one.score || one.start - other.start)
    .slice(0, PASSAGES_PER_FILE)
    .sort((one, other) => one.start - other.start)
    .map((window) => ({
      start: window.start + 1,
      end: window.end,
      sketch: sketchOf(lines.slice(window.start, window.end), terms),
    }));
}
