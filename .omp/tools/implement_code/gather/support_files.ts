import type { Excerpt } from "../conventions.js";
import { relativeImports, resolveImport } from "../imports.js";
import { isTestPath } from "../paths.js";
import type { HostMachine } from "../machine.js";
import { present, readExcerpt } from "./excerpts.js";
import { MAX_SUPPORT_CHARS, MAX_SUPPORT_FILES } from "./limits.js";

/**
 * The files of the test tree that `tests` import, such as fakes and harnesses: what a new test needs to know to call
 * them the way these do. The most imported first; the tests themselves are not repeated.
 */
export async function readSupportFiles(
  machine: HostMachine,
  repo: string,
  tests: readonly Excerpt[],
  known: ReadonlySet<string>,
): Promise<Excerpt[]> {
  const own = new Set(tests.map((test) => test.path));
  const counts = new Map<string, number>();
  for (const test of tests) {
    for (const specifier of relativeImports(test.text)) {
      const path = resolveImport(test.path, specifier, known);
      if (path !== undefined && isTestPath(path) && !own.has(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const wanted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(
    0,
    MAX_SUPPORT_FILES,
  );
  const read = await Promise.all(wanted.map(([path]) => readExcerpt(machine, repo, path, MAX_SUPPORT_CHARS)));
  return read.filter(present);
}
