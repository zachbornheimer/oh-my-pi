import {
  basenameOf,
  dirnameOf,
  extensionOf,
  isTestPath,
  stemOf,
  subjectStemOf,
} from "../paths.js";
import type { Design } from "../schemas.js";
import { wordsOf } from "../words.js";
import type { DirectoryInfo } from "./directories.js";
import { designWeights, matchWeight } from "./home_ranking.js";
import { MAX_FILES_PER_SIBLING, MAX_SIBLINGS, MAX_TESTS_PER_SIBLING } from "./limits.js";

/** Extensions of files worth showing as examples. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".go",
  ".py",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".css",
]);
const BARREL_STEMS = new Set(["index", "mod", "__init__"]);
const SCHEMA_STEM = "schemas";
const README = "README.md";
const MIN_SUBDIRECTORY_UNITS = 2;

/** A thing already in the repo that the design resembles: a directory of files, or one file, and the tests that cover it. */
export interface SiblingUnit {
  readonly name: string;
  readonly files: string[];
  readonly tests: string[];
}

const isSourceFile = (path: string): boolean =>
  TEXT_EXTENSIONS.has(extensionOf(path)) && !isTestPath(path) && !BARREL_STEMS.has(stemOf(path));

function filesUnder(index: ReadonlyMap<string, DirectoryInfo>, directory: string): string[] {
  const info = index.get(directory);
  if (info === undefined) return [];
  return [...info.files, ...info.subdirectories.flatMap((child) => filesUnder(index, child))].filter(isSourceFile);
}

/** The order a unit's files are shown in: the file named for the unit, its schemas, its README, the rest. */
function fileOrder(unitName: string): (a: string, b: string) => number {
  const rank = (path: string): number => {
    if (stemOf(path) === unitName) return 0;
    if (stemOf(path) === SCHEMA_STEM) return 1;
    return basenameOf(path) === README ? 2 : 3;
  };
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

function unitsOf(index: ReadonlyMap<string, DirectoryInfo>, home: string): SiblingUnit[] {
  const info = index.get(home);
  if (info === undefined) return [];
  const directoryUnits = info.subdirectories
    .map((directory) => ({ name: basenameOf(directory), files: filesUnder(index, directory), tests: [] as string[] }))
    .filter((unit) => unit.files.length > 0);
  if (directoryUnits.length >= MIN_SUBDIRECTORY_UNITS) return directoryUnits;
  return info.files.filter(isSourceFile).map((file) => ({ name: stemOf(file), files: [file], tests: [] }));
}

function testsOf(unit: SiblingUnit, paths: readonly string[]): string[] {
  const covers = (path: string): boolean =>
    subjectStemOf(path) === unit.name || dirnameOf(path).split("/").includes(unit.name);
  const found = paths.filter((path) => isTestPath(path) && covers(path));
  const direct = (path: string): number => Number(subjectStemOf(path) !== unit.name);
  return found.sort((a, b) => direct(a) - direct(b) || a.localeCompare(b)).slice(0, MAX_TESTS_PER_SIBLING);
}

function median(numbers: readonly number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bestUnits(
  index: ReadonlyMap<string, DirectoryInfo>,
  home: string,
  design: Design,
  paths: readonly string[],
): SiblingUnit[] {
  const weights = designWeights(design);
  const units = unitsOf(index, home);
  const typical = median(units.map((unit) => unit.files.length));
  return units
    .map((unit) => ({ unit, score: matchWeight(weights, wordsOf(unit.name)) }))
    .sort((a, b) =>
      b.score - a.score || Math.abs(a.unit.files.length - typical) - Math.abs(b.unit.files.length - typical)
      || a.unit.name.localeCompare(b.unit.name)
    )
    .map(({ unit }) => ({
      name: unit.name,
      files: unit.files.sort(fileOrder(unit.name)).slice(0, MAX_FILES_PER_SIBLING),
      tests: testsOf(unit, paths),
    }));
}

/**
 * The closest existing siblings of the design: the best units of the best home, then of the next home when the first
 * has too few. A unit is a subdirectory of the home when the home is a directory of such units, else a file.
 */
export function chooseSiblings(
  index: ReadonlyMap<string, DirectoryInfo>,
  homes: readonly string[],
  design: Design,
  paths: readonly string[],
): SiblingUnit[] {
  return homes.flatMap((home) => bestUnits(index, home, design, paths)).slice(0, MAX_SIBLINGS);
}
