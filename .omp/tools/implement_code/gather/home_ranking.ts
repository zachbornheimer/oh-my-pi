import { type DesignWords, designWords } from "../design_text.js";
import { basenameOf, isTestPath, stemOf } from "../paths.js";
import type { Design } from "../schemas.js";
import { wordsOf } from "../words.js";
import type { DirectoryInfo } from "./directories.js";
import { MAX_HOMES } from "./limits.js";

const NAME_WORD_WEIGHT = 2;
const REST_WORD_WEIGHT = 1;
const FILE_STEM_SHARE = 0.5;

/** The design's words with their weights: those of its name count double. */
export function designWeights(design: Design): Map<string, number> {
  const words: DesignWords = designWords(design);
  const weights = new Map<string, number>();
  for (const word of words.rest) weights.set(word, REST_WORD_WEIGHT);
  for (const word of words.name) weights.set(word, NAME_WORD_WEIGHT);
  return weights;
}

/** The weight of the design's words found among `candidates`, each design word counted once. */
export function matchWeight(weights: ReadonlyMap<string, number>, candidates: Iterable<string>): number {
  const found = new Set(candidates);
  let total = 0;
  for (const [word, weight] of weights) if (found.has(word)) total += weight;
  return total;
}

function scoreOf(directory: DirectoryInfo, weights: ReadonlyMap<string, number>): number {
  const named = matchWeight(weights, wordsOf(directory.path.split("/").join(" ")));
  const stems = directory.files.filter((file) => !isTestPath(file)).flatMap((file) => wordsOf(stemOf(file)));
  return named + FILE_STEM_SHARE * matchWeight(weights, stems);
}

const depthOf = (path: string): number => (path === "" ? 0 : path.split("/").length);
const holdsTests = (path: string): boolean => path !== "" && isTestPath(`${path}/x`);

interface Scored {
  readonly directory: DirectoryInfo;
  readonly score: number;
}

function byFit(a: Scored, b: Scored): number {
  return Number(holdsTests(a.directory.path)) - Number(holdsTests(b.directory.path))
    || b.score - a.score
    || depthOf(a.directory.path) - depthOf(b.directory.path)
    || (b.directory.files.length + b.directory.subdirectories.length)
      - (a.directory.files.length + a.directory.subdirectories.length)
    || a.directory.path.localeCompare(b.directory.path);
}

/**
 * The directories the design most likely belongs in, best first: those whose path and file names share the most words
 * with the design (words of its name count double), tests never first. `near` names a path or directory the caller
 * wants first. Empty when no directory shares a word and nothing is hinted.
 */
export function rankHomes(
  index: ReadonlyMap<string, DirectoryInfo>,
  design: Design,
  near: string | undefined,
): string[] {
  const weights = designWeights(design);
  const ranked = [...index.values()]
    .map((directory) => ({ directory, score: scoreOf(directory, weights) }))
    .filter((entry) => entry.score > 0 && entry.directory.path !== "")
    .sort(byFit)
    .map((entry) => entry.directory.path);
  const hinted = near === undefined ? undefined : hintedDirectory(index, near);
  const lifted = ranked.map((directory) => collectionOf(index, directory));
  const candidates = [...new Set(hinted === undefined ? lifted : [hinted, ...lifted])];
  return apart(candidates).slice(0, MAX_HOMES);
}

const MIN_UNIT_SIBLINGS = 2;

/** A unit directory holds a file named after it (`derive_workflow/derive_workflow.ts`). */
function isUnitDirectory(index: ReadonlyMap<string, DirectoryInfo>, directory: string): boolean {
  return index.get(directory)?.files.some((file) => stemOf(file) === basenameOf(directory)) ?? false;
}

/**
 * The directory a unit directory belongs to when most of that directory's subdirectories are units too: the design
 * would be a new unit beside them, so their parent is the home, not the unit that happened to share a word.
 */
function collectionOf(index: ReadonlyMap<string, DirectoryInfo>, directory: string): string {
  const parent = index.get(directory.slice(0, Math.max(0, directory.lastIndexOf("/"))));
  if (parent === undefined || parent.path === "" || !isUnitDirectory(index, directory)) return directory;
  const units = parent.subdirectories.filter((child) => isUnitDirectory(index, child));
  return units.length >= MIN_UNIT_SIBLINGS && units.length * 2 >= parent.subdirectories.length
    ? parent.path
    : directory;
}

const within = (path: string, directory: string): boolean => path.startsWith(`${directory}/`);

/** The directories with each one inside an earlier one left out: a sub-directory adds no second opinion. */
function apart(candidates: readonly string[]): string[] {
  return candidates.filter((path, position) => !candidates.slice(0, position).some((earlier) => within(path, earlier)));
}

function hintedDirectory(index: ReadonlyMap<string, DirectoryInfo>, near: string): string | undefined {
  const trimmed = near.replace(/\/+$/, "");
  if (index.has(trimmed)) return trimmed;
  const parent = trimmed.slice(0, Math.max(0, trimmed.lastIndexOf("/")));
  return basenameOf(trimmed) !== "" && index.has(parent) ? parent : undefined;
}
