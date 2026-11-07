import type { Registry } from "../conventions.js";
import { MANIFEST_FILE_NAMES } from "../editable_files.js";
import { basenameOf, dirnameOf, extensionOf } from "../paths.js";
import type { HostMachine } from "../machine.js";
import { chainOf } from "./directories.js";
import { present, readExcerpt } from "./excerpts.js";
import { MAX_REGISTRIES, MAX_REGISTRY_CHARS } from "./limits.js";

/** Files that list a directory's modules by name. */
const BARREL_NAMES = new Set(["index.ts", "index.tsx", "index.js", "index.mjs", "mod.ts", "mod.rs", "__init__.py"]);
const GO_EXTENSION = ".go";
const GO_INIT = /func init\(\)/;
const GO_REGISTRATION = /\bRegister\w*\(/;

function barrelPaths(paths: readonly string[], directories: readonly string[]): string[] {
  const wanted = new Set(directories);
  return paths.filter((path) => wanted.has(dirnameOf(path)) && BARREL_NAMES.has(basenameOf(path)));
}

function manifestPaths(paths: readonly string[], directories: readonly string[]): string[] {
  const wanted = new Set(directories);
  return paths.filter((path) => wanted.has(dirnameOf(path)) && MANIFEST_FILE_NAMES.has(basenameOf(path)));
}

/** Go registers modules in `init()` functions of the package: the package files that call a Register function. */
async function goRegistries(
  machine: HostMachine,
  repo: string,
  paths: readonly string[],
  homes: readonly string[],
): Promise<Registry[]> {
  const candidates = paths.filter((path) => homes.includes(dirnameOf(path)) && extensionOf(path) === GO_EXTENSION);
  const read = await Promise.all(candidates.map((path) => readExcerpt(machine, repo, path, MAX_REGISTRY_CHARS)));
  return read.filter(present).filter((registry) => GO_INIT.test(registry.text) && GO_REGISTRATION.test(registry.text));
}

/**
 * The existing files that list modules by name near the design: barrels in the home directories and the one above
 * each, the package and task manifests above them, and Go files that register in `init()`.
 */
export async function findRegistries(
  machine: HostMachine,
  repo: string,
  paths: readonly string[],
  homes: readonly string[],
): Promise<Registry[]> {
  const barrelDirectories = homes.flatMap((home) => [home, dirnameOf(home)]);
  const manifestDirectories = homes.flatMap(chainOf);
  const named = [...new Set([...barrelPaths(paths, barrelDirectories), ...manifestPaths(paths, manifestDirectories)])];
  const read = await Promise.all(named.map((path) => readExcerpt(machine, repo, path, MAX_REGISTRY_CHARS)));
  const registries = [...read.filter(present), ...await goRegistries(machine, repo, paths, homes)];
  return registries.slice(0, MAX_REGISTRIES);
}
