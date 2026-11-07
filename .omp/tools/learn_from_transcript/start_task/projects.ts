/**
 * Which board a name-addressed atask call lands on.
 *
 * atask resolves `--project` by name, ignoring case and punctuation, and refuses a name that two projects
 * share. Resolving the name against the registry first — and preferring the project that has a checkout —
 * keeps a name-addressed call landing on one board.
 */

/** One project as `atask projects --json` lists it. */
export interface AtaskProject {
  readonly id: string;
  readonly name: string;
  /** The repository the project was adopted from; absent for a project with no directory. */
  readonly root_path?: string;
}

/** Every registered project. Injected so a test never runs the CLI. */
export type ProjectsSource = () => Promise<readonly AtaskProject[]>;

/** How long one `projects` reading is reused. */
const PROJECTS_TTL_MS = 60_000;

interface Listing {
  readonly at: number;
  readonly projects: readonly AtaskProject[];
}

const listings = new WeakMap<ProjectsSource, Listing>();

/** The project list, read at most once per TTL for one source. A failed read is not cached. */
export async function projectsOf(source: ProjectsSource): Promise<readonly AtaskProject[]> {
  const cached = listings.get(source);
  if (cached !== undefined && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.projects;
  const projects = await source();
  listings.set(source, { at: Date.now(), projects });
  return projects;
}

/** Every project in one `atask projects --json` stdout. An unreadable listing throws rather than answering none. */
export function projectsFromList(stdout: string): readonly AtaskProject[] {
  const envelope = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: { message?: string } };
  if (envelope.ok !== true) throw new Error(`atask projects failed: ${envelope.error?.message ?? "no reason given"}`);
  if (!Array.isArray(envelope.result)) throw new Error("atask projects returned no project list");
  return envelope.result.flatMap((entry: unknown) => {
    const project = entry as { id?: unknown; name?: unknown; root_path?: unknown };
    if (typeof project.id !== "string" || typeof project.name !== "string") return [];
    const root = typeof project.root_path === "string" && project.root_path !== "" ? project.root_path : undefined;
    return [{ id: project.id, name: project.name, ...(root === undefined ? {} : { root_path: root }) }];
  });
}

/** atask's own name rule: case and punctuation are ignored, so `AI Tooling` and `ai-tooling` are the same name. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const PROJECT_ID = /^proj-[a-z0-9]+$/;

function trimRoot(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The value to pass as `--project` for `name`.
 *
 * A project id passes through. A name answers the id of the one project carrying it; when several do, the one
 * whose checkout is `hint` — else the only one with a checkout at all. A name nothing carries, and a name two
 * checkouts share, come back unchanged: atask's own message names the candidates.
 */
export function pickProject(projects: readonly AtaskProject[], name: string, hint?: string): string {
  if (PROJECT_ID.test(name)) return name;
  const key = nameKey(name);
  if (key === "") return name;
  const named = projects.filter((project) => nameKey(project.name) === key);
  if (named.length === 1) return named[0].id;
  const checkedOut = named.filter((project) => project.root_path !== undefined);
  if (hint !== undefined && hint !== "") {
    const target = trimRoot(hint);
    const matches = checkedOut.filter((project) =>
      trimRoot(project.root_path ?? "") === target || target.startsWith(`${trimRoot(project.root_path ?? "")}/`)
    );
    if (matches.length === 1) return matches[0].id;
  }
  return checkedOut.length === 1 ? checkedOut[0].id : name;
}

/** {@link pickProject} over a live registry read; an unreadable registry answers the name unchanged. */
export async function resolveProject(name: string, source: ProjectsSource, hint?: string): Promise<string> {
  if (PROJECT_ID.test(name)) return name;
  try {
    return pickProject(await projectsOf(source), name, hint);
  } catch {
    return name;
  }
}
