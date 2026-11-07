/** The most test files a brief shows as near the goal. */
export const NEAR_GOAL_LIMIT = 30;

const MIN_TOKEN_LENGTH = 3;
/** A test beside a changed file is probably the test of that file. */
const SAME_DIRECTORY_BONUS = 2;
/** Words every path or goal has, and file-type words that say nothing about what a file is for. */
const FILLER_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "when",
  "not",
  "are",
  "was",
  "but",
  "all",
  "any",
  "can",
  "has",
  "have",
  "its",
  "into",
  "then",
  "than",
  "via",
  "like",
  "make",
  "test",
  "tests",
  "spec",
  "specs",
  "src",
  "lib",
  "pkg",
  "internal",
  "index",
  "main",
  "tsx",
  "mjs",
  "jsx",
  "bats",
]);
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/;

/** The distinct lowercase words of `text` (a goal, a path or an identifier), without filler, in order of first use. */
export function tokensOf(text: string): string[] {
  const words = text.replace(CAMEL_BOUNDARY, "$1 $2").toLowerCase().split(NON_ALPHANUMERIC);
  return [...new Set(words.filter((word) => word.length >= MIN_TOKEN_LENGTH && !FILLER_TOKENS.has(word)))];
}

/** Plural and past-tense endings, so "models" and "ranked" find "model" and "rank". */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

const stemsOf = (text: string): string[] => tokensOf(text).map(stem);

const directoryOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

export interface Scored {
  readonly path: string;
  readonly score: number;
}

function scoredByRelevance(paths: readonly string[], focus: string, changedFiles: readonly string[]): Scored[] {
  const wanted = new Set(stemsOf(`${focus} ${changedFiles.join(" ")}`));
  const changedDirectories = new Set(changedFiles.map(directoryOf));
  return paths
    .map((path) => {
      const shared = new Set(stemsOf(path).filter((stemmed) => wanted.has(stemmed))).size;
      const beside = changedDirectories.has(directoryOf(path)) ? SAME_DIRECTORY_BONUS : 0;
      return { path, score: shared + beside };
    })
    .sort((a, b) => b.score - a.score);
}

/** `paths` with the ones that share the most words with `focus` (or sit beside a changed file) first; ties keep their order. */
export function rankByRelevance(
  paths: readonly string[],
  focus: string,
  changedFiles: readonly string[] = [],
): string[] {
  return scoredByRelevance(paths, focus, changedFiles).map(({ path }) => path);
}

/** The test files that share a word with the goal or sit beside a changed file, most relevant first, with how many words they share. */
export function scoredNearGoal(
  testFiles: readonly string[],
  goal: string,
  changedFiles: readonly string[],
): Scored[] {
  return scoredByRelevance(testFiles, goal, changedFiles).filter(({ score }) => score > 0);
}

/** The test files that share a word with the goal or sit beside a changed file, most relevant first, at most `limit`. */
export function testIndexNearGoal(
  testFiles: readonly string[],
  goal: string,
  changedFiles: readonly string[],
  limit: number = NEAR_GOAL_LIMIT,
): string[] {
  return scoredNearGoal(testFiles, goal, changedFiles).slice(0, limit).map(({ path }) => path);
}

/** The project's `test` mise tasks that share a word with the goal (`test:jellyfin-memory` for a goal about Jellyfin memory), most shared first. */
export function miseTestTasksNearGoal(
  miseTasks: readonly string[],
  goal: string,
  changedFiles: readonly string[],
): string[] {
  const tests = miseTasks.filter((task) => task === "test" || task.startsWith("test:"));
  return scoredNearGoal(tests, goal, changedFiles).map(({ path }) => path);
}
