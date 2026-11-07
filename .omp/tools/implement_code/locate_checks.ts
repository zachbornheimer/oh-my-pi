import type { Conventions } from "./conventions.js";
import { ownerOf } from "./draft_job.js";
import { editableFile } from "./editable_files.js";
import { nameProblem } from "./how_names.js";
import { ancestorsOf, basenameOf, dirnameOf, stemOf, subjectStemOf } from "./paths.js";
import type { FileRole } from "./schemas.js";

/** A file the model proposes to create or edit. */
export interface PlannedFile {
  readonly path: string;
  readonly role: FileRole;
  readonly reason: string;
}

/** Files that only declare shapes or names: they need no test of their own. */
export const DECLARATION_ONLY_STEMS: readonly string[] = ["schemas", "types", "constants", "index"];

const PARENT_SEGMENT = "..";
/** More files than this is a design too big for one pass: split it. */
export const MAX_PLANNED_FILES = 12;

function pathProblem(path: string): string | undefined {
  if (path.trim() === "" || path.startsWith("/") || path.includes("\\") || path.split("/").includes(PARENT_SEGMENT)) {
    return `"${path}" must be a path inside the repo, relative to its root, written with /`;
  }
  return undefined;
}

function existingFileProblem(file: PlannedFile, conventions: Conventions): string | undefined {
  if (file.role !== "registry") {
    return `"${file.path}" already exists: choose a new path (only a registry or a call site may be edited)`;
  }
  return editableFile(conventions, file.path) === undefined
    ? `"${file.path}" cannot be edited: it is not a registry or sibling file listed in the brief, or it was too long to read whole`
    : undefined;
}

function newNameProblem(path: string, knownDirectories: ReadonlySet<string>): string | undefined {
  const created = ancestorsOf(path).reverse().filter((directory) =>
    directory !== "" && !knownDirectories.has(directory)
  );
  const names = [...created.map((directory) => directory.slice(directory.lastIndexOf("/") + 1)), stemOf(path)];
  return names.map(nameProblem).find((problem) => problem !== undefined);
}

function testCovers(test: PlannedFile, module: PlannedFile): boolean {
  const moduleStem = stemOf(module.path);
  return subjectStemOf(test.path).includes(moduleStem) || dirnameOf(test.path).split("/").includes(moduleStem);
}

function testPlacementProblem(
  tests: readonly PlannedFile[],
  modules: readonly PlannedFile[],
  conventions: Conventions,
): string | undefined {
  const { test_layout, test_root } = conventions.style;
  const moduleDirectories = new Set(modules.map((module) => dirnameOf(module.path)));
  for (const test of tests) {
    if (test_layout === "beside_code" && !moduleDirectories.has(dirnameOf(test.path))) {
      return `this repo keeps tests beside the code: put "${test.path}" in the directory of the module it tests`;
    }
    if (test_layout === "separate_tree" && test_root !== "" && !test.path.startsWith(`${test_root}/`)) {
      return `this repo keeps tests under ${test_root}/: move "${test.path}" there`;
    }
  }
  return undefined;
}

const OWNER_PLACEHOLDER = "<name>";
/** Fewer siblings than this make no convention: one example is not a pattern. */
const MIN_SIBLINGS_FOR_SHAPE = 2;

/** The files directly in a sibling directory by role: the file name with the sibling's name taken out. */
function rolesOf(sibling: Conventions["siblings"][number]): Set<string> {
  const marker = `/${sibling.name}/`;
  const roles = sibling.files.flatMap((file) => {
    const at = file.path.indexOf(marker);
    const below = at < 0 ? "" : file.path.slice(at + marker.length);
    return below === "" || below.includes("/") ? [] : [below.replaceAll(sibling.name, OWNER_PLACEHOLDER)];
  });
  return new Set(roles);
}

/** What every sibling directory has that the plan's own directory lacks: the shape the siblings share. */
function siblingShapeProblems(files: readonly PlannedFile[], conventions: Conventions): string[] {
  const directories = conventions.siblings.filter((sibling) => sibling.files.length > 1);
  const primary = files.find((file) =>
    file.role === "module" && stemOf(file.path) === basenameOf(dirnameOf(file.path))
  );
  if (directories.length < MIN_SIBLINGS_FOR_SHAPE || primary === undefined) return [];
  const [first, ...others] = directories.map(rolesOf);
  const shared = [...first!].filter((role) => others.every((roles) => roles.has(role)));
  const owner = ownerOf(files);
  const planned = new Set(files.map((file) => file.path));
  return shared
    .map((role) => `${dirnameOf(primary.path)}/${role.replaceAll(OWNER_PLACEHOLDER, owner)}`)
    .filter((expected) => !planned.has(expected))
    .map((expected) => `every sibling directory has a file like ${basenameOf(expected)}: add ${expected}`);
}

/**
 * Why a proposed file set breaks the brief, in the model's words: paths outside the repo, an overwrite, a module with
 * no test, a name that says how, tests in the wrong place. Empty when the set is fine.
 */
export function locateProblems(files: readonly PlannedFile[], conventions: Conventions): string[] {
  const known = new Set(conventions.layout.known_files);
  const knownDirectories = new Set(conventions.layout.known_files.flatMap((path) => ancestorsOf(path)));
  const problems: (string | undefined)[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    problems.push(pathProblem(file.path));
    if (seen.has(file.path)) problems.push(`"${file.path}" is listed twice`);
    seen.add(file.path);
    if (known.has(file.path)) problems.push(existingFileProblem(file, conventions));
    else if (file.role === "registry") {
      problems.push(`registry "${file.path}" does not exist: a registry is an existing file`);
    }
    if (!known.has(file.path) && file.role !== "registry") problems.push(newNameProblem(file.path, knownDirectories));
  }
  if (files.length > MAX_PLANNED_FILES) {
    problems.push(
      `${files.length} files is more than the ${MAX_PLANNED_FILES} one change may hold: fold the small ones together or leave out what the design does not need`,
    );
  }
  const modules = files.filter((file) => file.role === "module");
  const tests = files.filter((file) => file.role === "test");
  if (modules.length === 0) problems.push("propose at least one module file");
  for (const module of modules) {
    const declarationOnly = DECLARATION_ONLY_STEMS.includes(stemOf(module.path));
    if (!declarationOnly && !tests.some((test) => testCovers(test, module))) {
      problems.push(
        `module "${module.path}" has no test: add a test file whose name contains "${stemOf(module.path)}"`,
      );
    }
  }
  problems.push(testPlacementProblem(tests, modules, conventions), ...siblingShapeProblems(files, conventions));
  return [...new Set(problems.filter((problem): problem is string => problem !== undefined))];
}
