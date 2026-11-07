import type { ScanMachine } from "./file_list.js";
import type { GateMachine } from "./gate.js";
import type { Passage, Window } from "./schemas.js";

/**
 * The host half of `orient`'s file access: the repository listing scoped to code (or to tests), each file read once,
 * and windows read back from disk in full so the judge verifies real lines, not a sketch. It never writes and never
 * calls a model.
 */

/** The machine operations a repository scan reads through. */
export type RepoMachine = Pick<ScanMachine, "run" | "readTextFile" | "listDirectory" | "isDirectory"> & GateMachine;

const WINDOW_LINE_CHARACTERS = 200;
const WINDOW_CHARACTERS = 2400;
const EVIDENCE_LINES = 2;

/** Prose and data: dense in words, never the code a behavior lives in. */
const DOC_OR_DATA = /\.(md|mdx|rst|txt|adoc|jsonl|ndjson|csv|tsv|snap|lock|log|svg)$/i;
/** Directories of recorded inputs and outputs rather than code. */
const DATA_DIRECTORY = /(^|\/)(fixtures?|testdata|__snapshots__|snapshots)\//;

/**
 * Whether a repository-relative path can hold code. Fixtures, snapshots and docs repeat a behavior's words more densely
 * than its implementation does, so a lexical scan that kept them would rank them first.
 */
export function isCodePath(path: string): boolean {
  return !DOC_OR_DATA.test(path) && !DATA_DIRECTORY.test(path);
}

/** Reads each file at most once per run, however many scans ask for it. */
export function cachedReader(
  machine: Pick<RepoMachine, "readTextFile">,
): (path: string) => Promise<string | undefined> {
  const read = new Map<string, Promise<string | undefined>>();
  return (path) => {
    let text = read.get(path);
    if (text === undefined) {
      text = machine.readTextFile(path);
      read.set(path, text);
    }
    return text;
  };
}

/**
 * `find`'s scan machine scoped to `repo` and to the repository-relative paths `keep` accepts: git runs with
 * `-C repo`, its listing and the fallback walk drop what `keep` refuses, and paths join under `repo`.
 */
export function repoScanMachine(
  machine: RepoMachine,
  repo: string,
  keep: (path: string) => boolean,
  read: (path: string) => Promise<string | undefined> = cachedReader(machine),
): ScanMachine & GateMachine {
  return {
    workingDirectory: repo,
    run: async (command, args) => {
      const result = await machine.run(command, command === "git" ? ["-C", repo, ...args] : args);
      if (command !== "git" || args[0] !== "ls-files" || result.code !== 0) return result;
      return { ...result, stdout: result.stdout.split("\n").filter((path) => path !== "" && keep(path)).join("\n") };
    },
    readTextFile: read,
    listDirectory: async (path) => {
      const kept: string[] = [];
      for (const name of await machine.listDirectory(path)) {
        const child = `${path}/${name}`;
        const rel = child.slice(repo.length + 1);
        if (await machine.isDirectory(child) ? !DATA_DIRECTORY.test(`${rel}/`) : keep(rel)) kept.push(name);
      }
      return kept;
    },
    isDirectory: (path) => machine.isDirectory(path),
    isFile: (path) => machine.isFile(path),
  };
}

function termsInLine(line: string, terms: readonly string[]): number {
  const lower = line.toLowerCase();
  return terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
}

const WINDOW_LINES = 40;
const WINDOW_STRIDE = 5;
const WINDOWS_PER_FILE = 3;
/** How much more a named identifier counts than a prose word when placing a window. */
const IDENTIFIER_WEIGHT = 3;

/** A line's weight when placing a window: one per prose term it holds, more per identifier. */
export function lineWeight(line: string, terms: readonly string[], identifiers: readonly string[]): number {
  return termsInLine(line, terms) + (IDENTIFIER_WEIGHT - 1) * termsInLine(line, identifiers);
}

/**
 * Up to three non-overlapping windows centred on the file's densest stretches. A fine stride lets a window cover a
 * fold and the join it feeds 38 lines later, where `find`'s fixed 20-line grid splits them; identifiers the behavior
 * names weigh more than its prose words, which a codebase repeats everywhere.
 */
export function peakWindows(text: string, terms: readonly string[], identifiers: readonly string[]): Passage[] {
  const lines = text.split("\n");
  const weights = lines.map((line) => lineWeight(line, terms, identifiers));
  const windows: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start < lines.length; start += WINDOW_STRIDE) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    windows.push({ start, end, score: weights.slice(start, end).reduce((total, weight) => total + weight, 0) });
    if (end === lines.length) break;
  }
  const picked: { start: number; end: number }[] = [];
  for (const window of windows.sort((one, other) => other.score - one.score || one.start - other.start)) {
    if (picked.length === WINDOWS_PER_FILE || window.score === 0) break;
    if (picked.every((kept) => window.end <= kept.start || window.start >= kept.end)) picked.push(window);
  }
  return picked
    .sort((one, other) => one.start - other.start)
    .map((window) => ({ start: window.start + 1, end: window.end, sketch: "" }));
}

/** The window's lines verbatim (at most `characters` of them), and its densest lines as `LINE: text` evidence. */
export function windowOf(
  lines: readonly string[],
  passage: Passage,
  terms: readonly string[],
  characters = WINDOW_CHARACTERS,
): Window {
  const slice = lines.slice(passage.start - 1, passage.end);
  const text = slice.map((line) => line.slice(0, WINDOW_LINE_CHARACTERS)).join("\n").slice(0, characters);
  const evidence = slice
    .map((line, index) => ({ line: line.trim(), number: passage.start + index, hits: termsInLine(line, terms) }))
    .filter((entry) => entry.line !== "" && entry.hits > 0)
    .sort((one, other) => other.hits - one.hits || one.number - other.number)
    .slice(0, EVIDENCE_LINES)
    .sort((one, other) => one.number - other.number)
    .map((entry) => `${entry.number}: ${entry.line.slice(0, WINDOW_LINE_CHARACTERS)}`)
    .join("\n");
  return { start: passage.start, end: passage.end, text, evidence };
}
