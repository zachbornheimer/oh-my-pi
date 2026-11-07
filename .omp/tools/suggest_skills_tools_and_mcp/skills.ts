import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CatalogEntry } from "./catalog.js";
import { parseFrontmatter } from "./frontmatter.js";

/** How much of a `SKILL.md` is read: the frontmatter is at the top, the body is never needed. */
const HEAD_BYTES = 16 * 1024;

/** The user-level skill roots omp scans (native, agents and Claude layouts), relative to the home directory. */
export const USER_SKILL_ROOTS = [".omp/agent/skills", ".agents/skills", ".claude/skills"] as const;
/** The project-level skill roots, relative to each ancestor directory of the working directory. */
export const PROJECT_SKILL_ROOTS = [".omp/skills", ".agents/skills", ".claude/skills"] as const;

export interface SkillRootsOptions {
  /** The working directory; project skill roots are read in it and each of its ancestors below the home directory. */
  cwd: string;
  home?: string;
  /** Extra skill roots (`<root>/<name>/SKILL.md`), scanned first. */
  extra?: readonly string[];
}

/** The skill roots to scan, the nearest to the work first: extra roots, project roots, then user roots. */
export function skillRoots(options: SkillRootsOptions): string[] {
  const home = resolve(options.home ?? (process.env.HOME || homedir()));
  const roots = [...(options.extra ?? []).map((root) => resolve(options.cwd, root))];
  let directory = resolve(options.cwd);
  while (directory !== home && dirname(directory) !== directory) {
    for (const root of PROJECT_SKILL_ROOTS) roots.push(join(directory, root));
    directory = dirname(directory);
  }
  for (const root of USER_SKILL_ROOTS) roots.push(join(home, root));
  return [...new Set(roots)];
}

export interface DiscoveredSkills {
  entries: CatalogEntry[];
  /** One message per root or skill that could not be read; a missing root is not an error. */
  errors: string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (error as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR";

async function head(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

const isFalse = (value: string | undefined): boolean => value !== undefined && value.trim().toLowerCase() === "false";
const isTrue = (value: string | undefined): boolean => value !== undefined && value.trim().toLowerCase() === "true";

/** The catalog entry of one skill directory, undefined when it is not a model-invocable skill. */
export async function skillEntry(directory: string, directoryName: string): Promise<CatalogEntry | undefined> {
  const front = parseFrontmatter(await head(join(directory, "SKILL.md"))) ?? {};
  if (isFalse(front.enabled) || isTrue(front.hide) || isTrue(front["disable-model-invocation"]) || isTrue(front.disableModelInvocation)) {
    return undefined;
  }
  const name = (front.name ?? "").trim() || directoryName;
  // `/` and `\` are reserved for namespaced skill addresses; omp itself rejects such a name.
  if (/[\\/]/.test(name)) return undefined;
  return {
    Kind: "skill",
    Name: name,
    Server: "",
    Description: (front.description ?? "").trim(),
    Path: name,
    HowToCall: `read({"path":"skill://${name}"})`,
    Harness: "",
  };
}

/**
 * The installed skills: `<root>/<name>/SKILL.md` one level under each root (a symlinked directory counts), the
 * first of a name winning, so the nearest root overrides. A missing root is skipped; any other unreadable root or
 * skill is reported in `errors` and the rest are still read.
 */
export async function discoverSkills(roots: readonly string[], signal?: AbortSignal): Promise<DiscoveredSkills> {
  const entries: CatalogEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    signal?.throwIfAborted();
    let names: string[];
    try {
      names = (await readdir(root)).sort();
    } catch (error) {
      if (!isMissing(error)) errors.push(`skill root ${root}: ${messageOf(error)}`);
      continue;
    }
    for (const directoryName of names) {
      const directory = join(root, directoryName);
      try {
        if (!(await stat(join(directory, "SKILL.md"))).isFile()) continue;
        const entry = await skillEntry(directory, directoryName);
        if (entry !== undefined && !seen.has(entry.Name)) {
          seen.add(entry.Name);
          entries.push(entry);
        }
      } catch (error) {
        if (!isMissing(error)) errors.push(`skill ${directory}: ${messageOf(error)}`);
      }
    }
  }
  return { entries, errors };
}
