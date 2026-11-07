import { listFiles, type ScanMachine } from "./file_list.js";
import { gateFor, type GateMachine } from "./gate.js";
import { scoreText } from "./keywords.js";
import { lineWeight, peakWindows, windowOf } from "./repo_scan.js";
import type { TestWindow } from "./schemas.js";

/**
 * The host half of `orient`'s test facet: which files are tests, which tests sit near the behavior's code, and the
 * test each window belongs to. A test file earns its place by naming a candidate source file's module (its stem) or
 * by carrying the behavior's terms; the judge later decides whether a window really exercises the behavior.
 */

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_tests?\.rs$/;
/** Module stems too generic to tie a test to one source file. */
const GENERIC_STEMS: Readonly<Record<string, true>> = {
  index: true,
  mod: true,
  main: true,
  lib: true,
  util: true,
  utils: true,
  types: true,
  schemas: true,
  __init__: true,
  helpers: true,
  common: true,
};
const MAX_TEST_FILES_READ = 2000;
const MAX_TEST_FILES_KEPT = 8;
const MAX_FILE_CHARACTERS = 512 * 1024;
const STEM_BONUS = 2;
/** How far above a window a test declaration may sit and still own it. */
const DECLARATION_REACH = 120;

/** Test code in a language `gateFor` knows a runner for. */
const RUNNABLE_TEST = /\.(rs|[cm]?[jt]sx?|go|py)$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path) && RUNNABLE_TEST.test(path);
}

/** `src/aggregator.rs` → `aggregator`; undefined for a generic or short stem. */
export function stemOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
  return stem.length >= 4 && GENERIC_STEMS[stem] !== true ? stem.toLowerCase() : undefined;
}

export interface TestDeclaration {
  readonly line: number;
  readonly name: string;
}

const JS_TEST = /\b(?:it|test)(?:\.(?:only|skip|concurrent))?\(\s*(["'`])((?:(?!\1).)+)\1/;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test_\w+)/;
const GO_TEST = /^func\s+(Test\w+)\s*\(/;
const RUST_FN = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/;
const RUST_TEST_ATTRIBUTE = /^\s*#\[[^\]]*\btest\b/;

/** Every test the file declares, with its 1-based line, by the file's language. */
export function testDeclarationsOf(path: string, text: string): TestDeclaration[] {
  const lines = text.split("\n");
  const found: TestDeclaration[] = [];
  lines.forEach((line, index) => {
    let name: string | undefined;
    if (path.endsWith(".rs")) {
      const fn = RUST_FN.exec(line)?.[1];
      if (fn !== undefined) {
        const above = lines.slice(Math.max(0, index - 4), index);
        if (above.some((previous) => RUST_TEST_ATTRIBUTE.test(previous))) name = fn;
      }
    } else if (path.endsWith(".py")) {
      name = PY_TEST.exec(line)?.[1];
    } else if (path.endsWith(".go")) {
      name = GO_TEST.exec(line)?.[1];
    } else {
      name = JS_TEST.exec(line)?.[2];
    }
    if (name !== undefined) found.push({ line: index + 1, name });
  });
  return found;
}

/** The test a window belongs to: the first declared inside it, else the nearest above it within reach. */
export function testNameFor(declarations: readonly TestDeclaration[], start: number, end: number): string | null {
  const inside = declarations.find((declaration) => declaration.line >= start && declaration.line <= end);
  if (inside !== undefined) return inside.name;
  const above = declarations
    .filter((declaration) => declaration.line < start && start - declaration.line <= DECLARATION_REACH)
    .at(-1);
  return above?.name ?? null;
}

/** Whether the text names one of the stems as a whole word; a set lookup, so no pattern is built from file names. */
function mentionsStem(text: string, stems: readonly string[]): boolean {
  if (stems.length === 0) return false;
  const words = new Set(text.toLowerCase().split(/[^a-z0-9_]+/));
  return stems.some((stem) => words.has(stem));
}

export interface TestProbe {
  readonly tests: TestWindow[];
  readonly testFilesScanned: number;
}

/** A Rust source file's own unit tests start here; everything above is the code they test. */
const INLINE_TEST_MODULE = /^\s*#\[cfg\(test\)\]/;
/** How many of the behavior's own source files are searched for inline unit tests. */
const MAX_INLINE_SOURCES = 4;

interface TestSource {
  readonly path: string;
  readonly text: string;
  /** The 0-based line where the file's tests begin: 0 for a test file, the test module for a source file. */
  readonly from: number;
}

/** A test's window runs from its declaration to the next one, at most this many lines. */
const TEST_WINDOW_LINES = 60;
/** A whole test body fits: assertions sit at its end, past where a code window would stop. */
const TEST_WINDOW_CHARACTERS = 4000;
const TEST_WINDOWS_PER_FILE = 3;

/**
 * One window per declared test, from its declaration to the next (capped). Tests are ranked first by how many lines
 * name an identifier the behavior names (the sharpest signal: a test asserting on `additionalContext`), then by
 * overall weight. A density window would cut tests in half; this one is a whole test the judge can read. A file with
 * no declarations falls back to density windows.
 */
export function testPassages(
  lines: readonly string[],
  declarations: readonly TestDeclaration[],
  from: number,
  terms: readonly string[],
  identifiers: readonly string[],
  weighted: readonly string[] = identifiers,
): { start: number; end: number; sketch: string }[] {
  const owned = declarations.filter((declaration) => declaration.line > from);
  if (owned.length === 0) {
    return peakWindows(lines.slice(from).join("\n"), terms, weighted)
      .map((passage) => ({ ...passage, start: passage.start + from, end: passage.end + from }));
  }
  return owned
    .map((declaration, index) => {
      const next = owned[index + 1]?.line ?? lines.length + 1;
      const end = Math.min(next - 1, declaration.line + TEST_WINDOW_LINES - 1, lines.length);
      const body = lines.slice(declaration.line - 1, end);
      const named = body.filter((line) => lineWeight(line, identifiers, []) > 0).length;
      const score = body.reduce((total, line) => total + lineWeight(line, terms, weighted), 0);
      return { start: declaration.line, end, named, score };
    })
    .filter((window) => window.score > 0)
    .sort((one, other) => other.named - one.named || other.score - one.score || one.start - other.start)
    .slice(0, TEST_WINDOWS_PER_FILE)
    .sort((one, other) => one.start - other.start)
    .map((window) => ({ start: window.start, end: window.end, sketch: "" }));
}

/** The windows of one test source, each named by its test and gated by the nearest manifest. */
async function windowsOf(
  machine: GateMachine,
  repo: string,
  source: TestSource,
  terms: readonly string[],
  identifiers: readonly string[],
  weighted: readonly string[],
): Promise<TestWindow[]> {
  const lines = source.text.split("\n");
  const declarations = testDeclarationsOf(source.path, source.text);
  const windows: TestWindow[] = [];
  for (const passage of testPassages(lines, declarations, source.from, terms, identifiers, weighted)) {
    const window = windowOf(lines, passage, terms, TEST_WINDOW_CHARACTERS);
    const name = testNameFor(declarations, window.start, window.end);
    const gated = await gateFor(machine, repo, source.path, name);
    windows.push({ ...window, path: source.path, name, gate: gated.gate, gateGap: gated.gap });
  }
  return windows;
}

/**
 * The test windows nearest the behavior. First the unit tests inside the behavior's own source files (a Rust
 * `#[cfg(test)]` module tests exactly the code above it), then test files scored by the behavior's terms plus the
 * candidate stems (a file naming a stem gets a bonus); each window carries its test name and the command that runs it.
 */
export async function probeTests(
  machine: ScanMachine & GateMachine,
  repo: string,
  terms: readonly string[],
  stems: readonly string[],
  identifiers: readonly string[] = [],
  sources: readonly string[] = [],
): Promise<TestProbe> {
  const allTerms = [...new Set([...terms, ...stems])];
  const weighted = [...identifiers, ...stems];
  // Every behavior candidate's own unit tests compete; the ones whose test module carries the most weight are kept.
  const inlineScored: { source: TestSource; score: number }[] = [];
  for (const path of sources) {
    const text = await machine.readTextFile(path);
    if (text === undefined || !path.endsWith(".rs")) continue;
    const lines = text.split("\n");
    const from = lines.findIndex((line) => INLINE_TEST_MODULE.test(line));
    if (from < 0 || testDeclarationsOf(path, text).length === 0) continue;
    const region = lines.slice(from).join("\n");
    inlineScored.push({ source: { path, text, from }, score: scoreText(region, allTerms) });
  }
  const inline = inlineScored
    .filter((entry) => entry.score > 0)
    .sort((one, other) => other.score - one.score || one.source.path.localeCompare(other.source.path))
    .slice(0, MAX_INLINE_SOURCES)
    .map((entry) => entry.source);
  const listing = await listFiles(machine);
  const testFiles = listing.files.filter(isTestPath).slice(0, MAX_TEST_FILES_READ);
  const scored: { path: string; score: number; text: string }[] = [];
  for (const rel of testFiles) {
    const path = `${repo}/${rel}`;
    const text = await machine.readTextFile(path);
    if (text === undefined || text.length > MAX_FILE_CHARACTERS || text.includes("\u0000")) continue;
    const score = scoreText(text, allTerms) + (mentionsStem(text, stems) ? STEM_BONUS : 0);
    if (score > 0) scored.push({ path, score, text });
  }
  const kept = scored
    .sort((one, other) => other.score - one.score || one.path.localeCompare(other.path))
    .slice(0, MAX_TEST_FILES_KEPT)
    .map((file) => ({ path: file.path, text: file.text, from: 0 }));
  const tests: TestWindow[] = [];
  for (const source of [...inline, ...kept]) {
    tests.push(...await windowsOf(machine, repo, source, allTerms, identifiers, weighted));
  }
  return { tests, testFilesScanned: testFiles.length + inline.length };
}
