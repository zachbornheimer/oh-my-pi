import {
  NEAR_GOAL_LIMIT,
  rankByRelevance,
  testIndexNearGoal,
} from "./test_index.js";
import type { Machine } from "./machine.js";

/** The most test files a project context holds; past it the ones most relevant to the gathering words are kept. */
export const TEST_FILE_LIMIT = 400;
/** How many of the most relevant test files are read for the names of their tests. */
export const TEST_NAME_FILE_LIMIT = 6;
/** The most test names kept per file. */
export const TEST_NAMES_PER_FILE = 20;

/** `git ls-files` pathspecs for test files at any depth (git's default pathspec lets `*` cross `/`). */
export const TEST_FILE_PATHSPECS = [
  "*_test.go",
  "*.test.ts",
  "*.test.tsx",
  "*.test.js",
  "*.spec.ts",
  "test/*",
  "*/test/*",
  "tests/*",
  "*/tests/*",
  "test_*.py",
  "*/test_*.py",
  "*_test.py",
  "*.bats",
] as const;

const TEST_NAMED = /(?:_test\.(?:go|py)|\.(?:test|spec)\.(?:tsx?|jsx?|mjs)|(?:^|\/)test_[^/]*\.py|\.bats)$/;
const IN_TEST_DIRECTORY = /(?:^|\/)tests?\//;
const SCRIPT_EXTENSION = /\.(?:ts|tsx|js|mjs|py|sh|bats|rb|php|rs|go)$/;
/** Directories under a test directory that hold helpers and data, not tests. */
const SUPPORT_DIRECTORY = /(?:^|\/)(?:support|fixtures?|testdata|__snapshots__|snapshots|helpers?)\//;

const isTestFile = (path: string): boolean =>
  path !== "" && !SUPPORT_DIRECTORY.test(path)
  && (TEST_NAMED.test(path) || (IN_TEST_DIRECTORY.test(path) && SCRIPT_EXTENSION.test(path)));

export interface TestFileListing {
  /** Undefined when git could not list them (not a repository): nothing can then be said of the project's tests. */
  readonly files: string[] | undefined;
  readonly truncated: boolean;
}

/** The project's tracked test files, path-sorted, at most `TEST_FILE_LIMIT`; when cut, the ones sharing most words with `focus` stay. */
export async function listTestFiles(home: string, focus: string, machine: Machine): Promise<TestFileListing> {
  const listed = await machine.run("git", ["-C", home, "ls-files", "--", ...TEST_FILE_PATHSPECS]);
  if (listed.code !== 0) return { files: undefined, truncated: false };
  const all = listed.stdout.split("\n").map((line) => line.trim()).filter(isTestFile);
  if (all.length <= TEST_FILE_LIMIT) return { files: all.sort(), truncated: false };
  return { files: rankByRelevance(all, focus).slice(0, TEST_FILE_LIMIT).sort(), truncated: true };
}

const GO_TEST = /^func (Test\w+)\(/gm;
const SCRIPT_TEST = /\b(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:(?!\1).)+)\1/g;
const PYTHON_TEST = /^\s*(?:async\s+)?def (test_\w+)/gm;

/** The names of the tests in a file, by its language; none for a language it does not know. */
export function extractTestNames(path: string, text: string): string[] {
  const names = path.endsWith(".go")
    ? [...text.matchAll(GO_TEST)].map((match) => match[1]!)
    : path.endsWith(".py")
    ? [...text.matchAll(PYTHON_TEST)].map((match) => match[1]!)
    : /\.(?:ts|tsx|js|mjs)$/.test(path)
    ? [...text.matchAll(SCRIPT_TEST)].map((match) => match[2]!)
    : [];
  return [...new Set(names)].slice(0, TEST_NAMES_PER_FILE);
}

/** The test names found in the files most relevant to `focus`, by file; a file that cannot be read or holds none is left out. */
export async function testNamesNear(
  home: string,
  files: readonly string[],
  focus: string,
  changedFiles: readonly string[],
  machine: Machine,
): Promise<Record<string, string[]>> {
  const nearest = testIndexNearGoal(files, focus, changedFiles, NEAR_GOAL_LIMIT).slice(0, TEST_NAME_FILE_LIMIT);
  const found = await Promise.all(nearest.map(async (file) => {
    const text = await machine.readTextFile(`${home}/${file}`);
    return [file, text === undefined ? [] : extractTestNames(file, text)] as const;
  }));
  return Object.fromEntries(found.filter(([, names]) => names.length > 0));
}

/** The files the work on the current branch changes against `targetBranch` (`git diff --name-only <target>...HEAD`). */
export async function changedFilesSince(home: string, targetBranch: string, machine: Machine): Promise<string[]> {
  const args = ["-C", home, "diff", "--name-only", `${targetBranch}...HEAD`];
  const diff = await machine.run("git", args);
  if (diff.code !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed (exit ${diff.code}): ${diff.stderr.trim() || diff.stdout.trim()}`,
    );
  }
  return diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}
