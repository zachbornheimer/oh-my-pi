import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { Exec } from "./omp_model.js";
import type { RepoContext } from "./session.js";

/**
 * The codebase an idea is about, read from the directory the caller is in or from an atask project: light context,
 * never the repository's files. Brownfield when `cwd` is inside a git repository that is not `$HOME` (and `cwd` is
 * not `$HOME`); anything else is greenfield.
 */

/** The most top-level entries an interview's codebase context lists. */
export const MAX_ENTRIES = 40;
/** The longest README opening shown, in characters. */
export const GOAL_MAX_CHARS = 240;
/** Files that open with a statement of purpose, best first. */
const GOAL_FILES = ["README.md", "AGENTS.md"] as const;

const HEADING = /^#{1,6}(\s|$)/;
const FENCE = /^\s*(```|~~~)/;
/** A first line that is markup, not prose: HTML, an image or badge, a table row, a rule, a quote. */
const NOT_PROSE = /^(<|!\[|\[!\[|\||>|-{3,}|={3,}|\*{3,})/;
const FRONT_MATTER_FENCE = "---";

function withoutFrontMatter(lines: readonly string[]): readonly string[] {
  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) return lines;
  const close = lines.findIndex((line, at) => at > 0 && line.trim() === FRONT_MATTER_FENCE);
  return close < 0 ? lines : lines.slice(close + 1);
}

/** The paragraphs of a markdown text outside code fences, each as its lines; headings end a paragraph and are dropped. */
function paragraphsOf(markdown: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current);
    current = [];
  };
  for (const line of withoutFrontMatter(markdown.split(/\r?\n/))) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      flush();
    } else if (fenced) {
      continue;
    } else if (line.trim() === "" || HEADING.test(line)) {
      flush();
    } else {
      current.push(line.trim());
    }
  }
  flush();
  return paragraphs;
}

function oneLine(text: string): string {
  const words = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(words);
  return characters.length <= GOAL_MAX_CHARS ? words : `${characters.slice(0, GOAL_MAX_CHARS - 1).join("")}…`;
}

/** The first paragraph of prose in a markdown text as one line, or "" when it has none. */
export function firstProse(markdown: string): string {
  const prose = paragraphsOf(markdown).find((lines) => !NOT_PROSE.test(lines[0] ?? ""));
  return prose === undefined ? "" : oneLine(prose.join(" "));
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** What the project at `root` says it is for: the first prose of its README.md, else of its AGENTS.md, else "". */
export async function repositoryGoal(root: string): Promise<string> {
  for (const file of GOAL_FILES) {
    const goal = firstProse(await readIfPresent(`${root}/${file}`));
    if (goal !== "") return goal;
  }
  return "";
}

/** The repository's name, top-level entries (dotfiles left out, sorted) and README opening. */
export async function repoContext(root: string): Promise<RepoContext> {
  const entries = (await readdir(root)).filter((entry) => !entry.startsWith(".")).sort().slice(0, MAX_ENTRIES);
  return { root, name: basename(root), entries, readme: await repositoryGoal(root) };
}

/** The top level of the git repository holding `cwd`; undefined outside one, or when that repository is `$HOME` itself. */
export async function repositoryOf(
  cwd: string,
  exec: Exec,
  home: string = homedir(),
  signal?: AbortSignal,
): Promise<string | undefined> {
  const where = resolve(cwd);
  if (where === resolve(home)) return undefined;
  const top = await exec("git", ["-C", where, "rev-parse", "--path-format=absolute", "--show-toplevel"], { signal });
  const root = top.stdout.trim();
  if (top.code !== 0 || root === "" || resolve(root) === resolve(home)) return undefined;
  return root;
}

const SAH_PREFIX = "sah:";
const PERSONAL_ROOT = "Developer/Personal";
const SAH_ROOT = "Developer/Software-Automation-Holdings";

/** A project of the local atask registry, with the directory it lives in when one is known (empty when none is). */
export interface RegisteredProject {
  id: string;
  name: string;
  home: string;
}

/** Where a project that has no registered path is expected to live: `sah:x` in the SAH root, any other name in Personal. */
export function conventionalHome(name: string, home: string): string {
  return name.startsWith(SAH_PREFIX)
    ? `${home}/${SAH_ROOT}/${name.slice(SAH_PREFIX.length)}`
    : `${home}/${PERSONAL_ROOT}/${name}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The projects `atask projects` lists. A failing or unreadable `atask` is an error naming what it said. */
export async function registeredProjects(
  exec: Exec,
  home: string = homedir(),
  signal?: AbortSignal,
): Promise<RegisteredProject[]> {
  const listed = await exec("env", ["ATASK_OUTPUT=json", "atask", "projects"], { signal });
  if (listed.code !== 0) {
    throw new Error(`\`atask projects\` failed (exit ${listed.code}): ${listed.stderr.trim() || listed.stdout.trim()}`);
  }
  let rows: { id: string; name: string; root_path?: string }[];
  try {
    const parsed = JSON.parse(listed.stdout) as { ok?: unknown; result?: unknown };
    if (parsed.ok !== true || !Array.isArray(parsed.result)) throw new Error("expected { ok: true, result: [...] }");
    rows = parsed.result.map((row: { id?: unknown; name?: unknown; root_path?: unknown }) => {
      if (typeof row.id !== "string" || typeof row.name !== "string") throw new Error("a project has no id or name");
      return { id: row.id, name: row.name, ...(typeof row.root_path === "string" ? { root_path: row.root_path } : {}) };
    });
  } catch (error) {
    throw new Error(`\`atask projects\` did not print the project registry: ${(error as Error).message}`);
  }
  return Promise.all(rows.map(async (project) => {
    const conventional = conventionalHome(project.name, home);
    const root = project.root_path ?? ((await isDirectory(conventional)) ? conventional : "");
    return { id: project.id, name: project.name, home: root };
  }));
}

/** The home of the atask project named by id or name; an unknown name is an error listing the known ones. */
export async function projectHome(
  project: string,
  exec: Exec,
  home: string = homedir(),
  signal?: AbortSignal,
): Promise<string> {
  const projects = await registeredProjects(exec, home, signal);
  const found = projects.find((candidate) => candidate.id === project || candidate.name === project);
  if (found === undefined) {
    throw new Error(
      `project ${JSON.stringify(project)} is not an atask project: one of ${projects.map((p) => p.name).join(", ")}`,
    );
  }
  if (found.home === "") throw new Error(`atask project ${found.name} has no home directory to read`);
  return found.home;
}

/** The brownfield context for an interview: the atask `project`'s home, else the repository holding `cwd`; undefined for greenfield. */
export async function contextFor(
  where: { cwd: string; project?: string },
  exec: Exec,
  home: string = homedir(),
  signal?: AbortSignal,
): Promise<RepoContext | undefined> {
  const root = where.project !== undefined
    ? await projectHome(where.project, exec, home, signal)
    : await repositoryOf(where.cwd, exec, home, signal);
  return root === undefined ? undefined : repoContext(root);
}
