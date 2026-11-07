import { detectRunners } from "./checkout_runners.js";
import { changedFilesSince, listTestFiles, testNamesNear } from "./checkout_tests.js";
import type { Machine } from "./machine.js";
import { testIndexNearGoal } from "./test_index.js";
import type { OpenTask, ProjectContext } from "./types.js";

/** The most entries the project's top level shows. */
export const TOP_LEVEL_LIMIT = 60;
/** The most entries one expanded directory shows. */
export const EXPANDED_LIMIT = 40;
/** Directories read one level deeper when a project has them: the places a proof is likely to name. */
const EXPANDED_DIRECTORIES = /^(?:docs|scripts|compose[^/]*|src)$/;
/** Entries that are tooling debris, not the project. */
const HIDDEN = /^\./;
const NOISE = new Set(["node_modules"]);
const JSON_OUTPUT = { ATASK_OUTPUT: "json" } as const;
const TASK_HEADER = /^\[tasks\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/;

const shown = (names: readonly string[]): string[] => names.filter((name) => !HIDDEN.test(name) && !NOISE.has(name));

interface Listed {
  readonly paths: string[];
  /** True when `limit` cut the directory's entries short. */
  readonly cut: boolean;
}

/** The children of `directory` as paths below `prefix` (a directory has a trailing `/`), at most `limit` of them. */
async function listed(directory: string, prefix: string, limit: number, machine: Machine): Promise<Listed> {
  const names = shown(await machine.listDirectory(directory));
  const kept = names.slice(0, limit);
  const paths = await Promise.all(
    kept.map(async (name) => `${prefix}${name}${await machine.isDirectory(`${directory}/${name}`) ? "/" : ""}`),
  );
  return { paths, cut: names.length > kept.length };
}

/** The project's top level, with its docs, scripts, compose and src directories opened one level, and which directories stay partial. */
export async function projectLayout(
  home: string,
  machine: Machine,
): Promise<Pick<ProjectContext, "Layout" | "Unlisted">> {
  const top = await listed(home, "", TOP_LEVEL_LIMIT, machine);
  const layout: string[] = [];
  const unlisted = new Set<string>(top.cut || top.paths.length === 0 ? [""] : []);
  for (const path of top.paths) {
    layout.push(path);
    if (!path.endsWith("/")) continue;
    const name = path.slice(0, -1);
    if (!EXPANDED_DIRECTORIES.test(name)) {
      unlisted.add(name);
      continue;
    }
    const inside = await listed(`${home}/${name}`, path, EXPANDED_LIMIT, machine);
    layout.push(...inside.paths);
    if (inside.cut) unlisted.add(name);
    for (const child of inside.paths.filter((p) => p.endsWith("/"))) unlisted.add(child.slice(0, -1));
  }
  return { Layout: layout, Unlisted: [...unlisted] };
}

const FILE_TASK_DIRECTORY = "mise-tasks";
const withoutExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "");

/** The tasks that are files under `mise-tasks/`: `NAME`, or `DIRECTORY:NAME` one level down. */
async function fileTasks(home: string, machine: Machine): Promise<string[]> {
  const root = `${home}/${FILE_TASK_DIRECTORY}`;
  const nested = await Promise.all((await machine.listDirectory(root)).map(async (name) => {
    if (!(await machine.isDirectory(`${root}/${name}`))) return [withoutExtension(name)];
    return (await machine.listDirectory(`${root}/${name}`)).map((child) => `${name}:${withoutExtension(child)}`);
  }));
  return nested.flat();
}

/** The project's mise tasks: the `[tasks.NAME]` tables of its mise.toml in file order, then its `mise-tasks/` files. */
export async function miseTasks(home: string, machine: Machine): Promise<string[]> {
  const toml = await machine.readTextFile(`${home}/mise.toml`);
  const declared = (toml ?? "").split(/\r?\n/).map((line) => TASK_HEADER.exec(line.trim()))
    .filter((match) => match !== null).map((match) => match[1] ?? match[2] ?? match[3]!);
  return [...new Set([...declared, ...await fileTasks(home, machine)])];
}

/** The unfinished atask tasks of `project` (an id or a name). A failing or unreadable `atask` is an error. */
export async function openTasks(project: string, machine: Machine): Promise<OpenTask[]> {
  const listing = await machine.run("atask", ["--project", project, "list", "open"], JSON_OUTPUT);
  if (listing.code !== 0) {
    throw new Error(
      `\`atask --project ${project} list open\` failed (exit ${listing.code}): ${
        listing.stderr.trim() || listing.stdout.trim()
      }`,
    );
  }
  try {
    const parsed = JSON.parse(listing.stdout) as { ok?: unknown; result?: { tasks?: unknown } };
    const tasks = parsed.result?.tasks;
    if (parsed.ok !== true || !Array.isArray(tasks)) throw new Error("expected { ok: true, result: { tasks: [...] } }");
    return tasks.map((task: { id?: unknown; title?: unknown }) => {
      if (typeof task.id !== "string" || typeof task.title !== "string") throw new Error("a task has no id or title");
      return { id: task.id, title: task.title };
    });
  } catch (error) {
    throw new Error(`\`atask --project ${project} list open\` did not print the tasks: ${(error as Error).message}`);
  }
}

/** What else a project context is gathered for: the words that decide which tests are kept, and the files the work changes. */
export interface ContextFocus {
  /** The goal in words; the test files and test names most relevant to it are kept when there are too many. */
  readonly words?: string;
  /** The files the work changes, when the caller knows them. */
  readonly changedFiles?: readonly string[];
  /** The branch the work will merge into; the changed files are then `git diff --name-only <branch>...HEAD`. */
  readonly targetBranch?: string;
}

async function changedFilesOf(home: string, focus: ContextFocus, machine: Machine): Promise<string[]> {
  if (focus.changedFiles !== undefined) return [...focus.changedFiles];
  return focus.targetBranch === undefined ? [] : changedFilesSince(home, focus.targetBranch, machine);
}

/**
 * What the writer needs to know of the checkout at `home`, which atask knows as `project` (undefined when atask does
 * not know it: it then has no open tasks): its layout, mise tasks and open tasks, and for aiming a proof, its test
 * runners, tracked test files, the test names in the ones nearest `focus` and the changed files. Test files and names
 * are left out when git cannot list them.
 */
export async function projectContext(
  project: string | undefined,
  home: string,
  machine: Machine,
  focus: ContextFocus = {},
): Promise<ProjectContext> {
  const words = focus.words ?? "";
  const [layout, tasks, open, tests, changed] = await Promise.all([
    projectLayout(home, machine),
    miseTasks(home, machine),
    project === undefined ? Promise.resolve([]) : openTasks(project, machine),
    listTestFiles(home, words, machine),
    changedFilesOf(home, focus, machine),
  ]);
  const files = tests.files ?? [];
  const [runners, names] = await Promise.all([
    detectRunners(home, files, testIndexNearGoal(files, words, changed), machine),
    testNamesNear(home, files, words, changed, machine),
  ]);
  return {
    Home: home,
    ...layout,
    MiseTasks: tasks,
    OpenTasks: open,
    Runners: runners,
    ...(tests.files === undefined ? {} : { TestFiles: tests.files, TestFilesTruncated: tests.truncated }),
    TestNames: names,
    ChangedFiles: changed,
  };
}

const SAH_PREFIX = "sah:";
const PERSONAL_ROOT = "Developer/Personal";
const SAH_ROOT = "Developer/Software-Automation-Holdings";

/** A project of the local atask registry, with the directory it lives in when one is known. */
export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  /** Empty when the registry has no path for it and none exists by convention. */
  readonly home: string;
}

/** Where a project that has no registered path is expected to live: `sah:x` in the SAH root, any other name in Personal. */
export function conventionalHome(name: string, homeDirectory: string): string {
  return name.startsWith(SAH_PREFIX)
    ? `${homeDirectory}/${SAH_ROOT}/${name.slice(SAH_PREFIX.length)}`
    : `${homeDirectory}/${PERSONAL_ROOT}/${name}`;
}

/** The projects `atask projects` lists. A failing or unreadable `atask` is an error naming what it said. */
export async function registeredProjects(machine: Machine): Promise<RegisteredProject[]> {
  const listed = await machine.run("atask", ["projects"], JSON_OUTPUT);
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
    const conventional = conventionalHome(project.name, machine.homeDirectory);
    const home = project.root_path ?? (await machine.isDirectory(conventional) ? conventional : "");
    return { id: project.id, name: project.name, home };
  }));
}

/** The longest goal a project shows, in characters. */
export const GOAL_MAX_CHARS = 240;
/** Files that open with a statement of purpose, best first. */
const GOAL_FILES = ["README.md", "AGENTS.md"] as const;
const HEADING = /^#{1,6}(\s|$)/;
const FENCE = /^\s*(```|~~~)/;
/** A first line that is markup, not prose: HTML, an image or badge, a table row, a rule, a quote. */
const NOT_PROSE = /^(<|!\[|\[!\[|\||>|-{3,}|={3,}|\*{3,})/;
const FRONT_MATTER_FENCE = "---";

/** The lines after a leading `---` block, when the text opens with one. */
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

/** What the project at `home` says it is for: the first prose of its README.md, else of its AGENTS.md, else "". */
export async function repositoryGoal(home: string, machine: Machine): Promise<string> {
  if (home === "") return "";
  for (const file of GOAL_FILES) {
    const goal = firstProse(await machine.readTextFile(`${home}/${file}`) ?? "");
    if (goal !== "") return goal;
  }
  return "";
}

const lastSegment = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** The checkout `project` names: a directory given by absolute path, else a registered project by id or name. */
export async function checkoutNamed(
  project: string,
  machine: Machine,
): Promise<{ readonly id: string | undefined; readonly name: string; readonly home: string } | undefined> {
  if (project.startsWith("/") && await machine.isDirectory(project)) {
    return { id: undefined, name: lastSegment(project), home: project.replace(/\/+$/, "") };
  }
  const wanted = project.trim().toLowerCase();
  const registered = (await registeredProjects(machine)).find((candidate) =>
    candidate.id.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted
  );
  return registered === undefined || registered.home === ""
    ? undefined
    : { id: registered.id, name: registered.name, home: registered.home };
}
