import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Where a seed and its spec are written, and how a written one is never replaced: each file is written to a
 * temporary sibling and then hard-linked to its name, which fails rather than overwrite. Version 1 is
 * `seed.json` + `spec.md`; a later crystallization of the same interview is `seed.v2.json` + `spec.v2.md`, and so on.
 */

/** The two file names of one version. */
export interface SpecFileNames {
  readonly seed: string;
  readonly spec: string;
}

export interface WrittenSpec {
  readonly version: number;
  readonly seedPath: string;
  readonly specPath: string;
}

const MAX_VERSIONS = 1000;

export function specFileNames(version: number): SpecFileNames {
  return version === 1
    ? { seed: "seed.json", spec: "spec.md" }
    : { seed: `seed.v${version}.json`, spec: `spec.v${version}.md` };
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lowest version whose seed and spec exist in none of `directories`. Every directory a version will be written
 * to is checked, so a repository copy never collides with a file already there after the store copy was written.
 */
export async function nextVersion(...directories: string[]): Promise<number> {
  for (let version = 1; version <= MAX_VERSIONS; version += 1) {
    const names = specFileNames(version);
    const taken = await Promise.all(
      directories.flatMap((directory) => [present(join(directory, names.seed)), present(join(directory, names.spec))]),
    );
    if (!taken.some(Boolean)) return version;
  }
  throw new Error(`${directories.join(" and ")} already hold ${MAX_VERSIONS} versions of this spec`);
}

/** Writes `text` to `path` only if nothing is there; a reader sees the whole file or none. */
async function writeNew(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite ${path}: a written seed or spec is immutable`);
    }
    throw error;
  } finally {
    await unlink(temporary);
  }
}

/** Writes one version's seed and spec into `directory`, never replacing either. */
export async function writeSpecFiles(
  directory: string,
  version: number,
  files: { readonly seed: string; readonly spec: string },
): Promise<WrittenSpec> {
  await mkdir(directory, { recursive: true });
  const names = specFileNames(version);
  const seedPath = join(directory, names.seed);
  const specPath = join(directory, names.spec);
  await writeNew(seedPath, files.seed);
  await writeNew(specPath, files.spec);
  return { version, seedPath, specPath };
}

/** The checkout `repo` names: an absolute directory holding `.git`; anything else is refused with the reason. */
export async function checkoutOf(repo: string): Promise<string> {
  if (!isAbsolute(repo)) throw new Error(`repo ${JSON.stringify(repo)} must be an absolute path`);
  if (!(await present(join(repo, ".git")))) throw new Error(`repo ${repo} is not a git checkout (no .git)`);
  return repo;
}
