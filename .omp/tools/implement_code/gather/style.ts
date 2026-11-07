import type { Excerpt, Sibling } from "../conventions.js";
import { extensionOf, isTestPath, stemOf } from "../paths.js";
import type { HostMachine } from "../machine.js";
import { chainOf } from "./directories.js";
import { present, readExcerpt } from "./excerpts.js";
import { MAX_CONFIG_CHARS, MAX_CONFIGS } from "./limits.js";

type Naming = "snake_case" | "kebab-case" | "camelCase" | "PascalCase" | "unknown";
type TestLayout = "separate_tree" | "beside_code" | "unknown";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
};
const UNKNOWN_LANGUAGE = "unknown";
const SCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);
const CONFIG_NAMES = [
  "dprint.jsonc",
  "dprint.json",
  ".editorconfig",
  "biome.json",
  "biome.jsonc",
  ".prettierrc",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.json",
  ".golangci.yml",
  ".golangci.yaml",
  "ruff.toml",
  "tsconfig.json",
];
const TEST_TREE_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const DEFAULT_EXPORT = /^export\s+default\b/m;

function mostCommon<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The language most of `paths` are written in. */
export function languageOf(paths: readonly string[]): string {
  const languages = paths.map((path) => LANGUAGE_BY_EXTENSION[extensionOf(path)]).filter(present);
  return mostCommon(languages) ?? UNKNOWN_LANGUAGE;
}

function namingOfName(name: string): Naming | undefined {
  if (name.includes("_")) return "snake_case";
  if (name.includes("-")) return "kebab-case";
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(name)) return "camelCase";
  if (/^[A-Z][a-z0-9][A-Za-z0-9]*$/.test(name)) return "PascalCase";
  return undefined;
}

/** How the repo spells multi-word file names, from the names of its siblings; one-word names say nothing. */
export function namingOf(names: readonly string[]): Naming {
  return mostCommon(names.map(namingOfName).filter(present)) ?? "unknown";
}

/** Where the repo's tests live, read from the tests of the siblings, else from every test in the repo. */
export function testLayoutOf(
  tests: readonly string[],
  allPaths: readonly string[],
): { layout: TestLayout; root: string } {
  const observed = tests.length > 0 ? tests : allPaths.filter(isTestPath);
  const rooted = observed.map((path) => path.split("/").findIndex((part) => TEST_TREE_NAMES.has(part)));
  const inTree = observed.filter((_path, index) => rooted[index]! >= 0);
  if (inTree.length > observed.length / 2) {
    const first = inTree[0]!;
    return { layout: "separate_tree", root: first.split("/").slice(0, rooted[observed.indexOf(first)]! + 1).join("/") };
  }
  return { layout: observed.length > 0 ? "beside_code" : "unknown", root: "" };
}

/** True when the language reads exports by name and no sibling uses a default export. */
export function namedExportsOnly(language: string, siblings: readonly Sibling[]): boolean {
  return SCRIPT_LANGUAGES.has(language)
    && !siblings.some((sibling) => sibling.files.some((file) => DEFAULT_EXPORT.test(file.text)));
}

/** Formatter, linter and compiler config files, the nearest to the home directory first. */
export async function readConfigs(
  machine: HostMachine,
  repo: string,
  paths: readonly string[],
  home: string,
): Promise<Excerpt[]> {
  const known = new Set(paths);
  const candidates = chainOf(home).flatMap((directory) =>
    CONFIG_NAMES.map((name) => (directory === "" ? name : `${directory}/${name}`)).filter((path) => known.has(path))
  );
  const read = await Promise.all(
    candidates.slice(0, MAX_CONFIGS).map((path) => readExcerpt(machine, repo, path, MAX_CONFIG_CHARS)),
  );
  return read.filter(present);
}

/** The names a sibling's files go by, for reading the naming style. */
export const namesOfSiblings = (siblings: readonly Sibling[]): string[] =>
  siblings.flatMap((sibling) => [sibling.name, ...sibling.files.map((file) => stemOf(file.path))]);
