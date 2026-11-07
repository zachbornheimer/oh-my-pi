/** Repo-relative paths, always with `/`. */

const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const TEST_STEM_MARKER = /(?:[._]test|[._]spec)$/;
const TEST_STEM_PREFIX = /^test_/;

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extensionOf(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/** The file name without its last extension: `a/derive_workflow.test.ts` -> `derive_workflow.test`. */
export function stemOf(path: string): string {
  const name = basenameOf(path);
  const extension = extensionOf(path);
  return extension === "" ? name : name.slice(0, -extension.length);
}

export const joinPath = (...parts: readonly string[]): string => parts.filter((part) => part !== "").join("/");

export function isTestPath(path: string): boolean {
  const stem = stemOf(path);
  const directories = dirnameOf(path).split("/");
  return directories.some((directory) => TEST_DIRECTORIES.has(directory)) || TEST_STEM_MARKER.test(stem)
    || TEST_STEM_PREFIX.test(stem);
}

/** What a test file is about: its stem without the test marker (`capability_usage_test` -> `capability_usage`). */
export function subjectStemOf(path: string): string {
  return stemOf(path).replace(TEST_STEM_MARKER, "").replace(TEST_STEM_PREFIX, "");
}

/** Every directory above `path`, nearest first, ending with "" for the repo root. */
export function ancestorsOf(path: string): string[] {
  const found: string[] = [];
  let current = dirnameOf(path);
  while (current !== "") {
    found.push(current);
    current = dirnameOf(current);
  }
  return [...found, ""];
}
