// Objective filing and dispatch: one atask objective per objective to fix, then one worker run per filed one.
//
// Filing is the atask CLI (`atask show` finds an existing objective, `atask add` files one; add is idempotent on
// title, and the PM's project resolves against atask's registry first: a name no single registered project carries
// never reaches atask, it files into atask's own default project with the substitution recorded).
// Dispatch starts one worker per ready filed objective, serialized per project: a project's objectives start one at a
// time, and a repeat call attaches to the live run instead of starting a second one.
import { type RunAtask, AtaskError, ataskEnvelope } from "./start_task/atask_cli.js";
import { type AtaskProject, type ProjectsSource, projectsFromList, resolveProject } from "./start_task/projects.js";
import { type StartAtaskTaskInput, type StartAtaskTaskOutput, normalizeInput } from "./start_task/schemas.js";
import { messageOf } from "./start_task/text.js";

/** One objective to fix, as the PM review yields it. */
export interface Objective {
  readonly title: string;
  readonly project?: string;
  readonly proof?: string;
  readonly regression?: string;
  readonly linear_link?: string;
  readonly atask_id?: string;
}

/** What the atask CLI reports about one objective it holds. */
export interface AtaskTask {
  readonly id: string;
  readonly status: string;
  readonly title?: string;
  readonly warning?: string;
}

/** An objective after filing: its atask id and status, or why atask refused it. */
export interface FiledObjective {
  readonly title: string;
  readonly project?: string;
  readonly atask_id?: string;
  readonly linear_link?: string;
  readonly filing?: "existing" | "created";
  readonly status: string;
  readonly warning?: string;
  readonly error?: string;
}

/** A filed objective with its dispatch outcome, or the reason no worker started. */
export interface DelegatedObjective extends FiledObjective {
  readonly delegated?: StartAtaskTaskOutput;
  readonly skip?: string;
}

/** The objectives a validated `Objectives` answer holds, reduced to the fields the filing reads. */
export function objectivesOf(answer: unknown): Objective[] {
  if (!Array.isArray(answer)) throw new Error("Objectives is not an array");
  return answer.map((entry, index) => {
    const record = entry as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || typeof record.title !== "string" || record.title === "") {
      throw new Error(`Objectives[${index}] has no title`);
    }
    const optional = (key: keyof Objective): Partial<Objective> => {
      const value = record[key];
      return typeof value === "string" && value !== "" ? { [key]: value } : {};
    };
    return {
      title: record.title,
      ...optional("project"),
      ...optional("proof"),
      ...optional("regression"),
      ...optional("linear_link"),
      ...optional("atask_id"),
    };
  });
}

/** The atask CLI as the filing port: `show` reads an objective, `add` files one, draft on bad checks. */
export interface FilingPort {
  show(id: string): Promise<AtaskTask>;
  add(objective: Objective): Promise<AtaskTask>;
}

const PROJECT_ID = /^proj-[a-z0-9]+$/;

/** The atask CLI as the filing port, with the registry read that keeps a name-addressed filing on one board. */
export function ataskFilingPort(run: RunAtask): FilingPort {
  const projects = projectSource(run);
  return {
    async show(id) {
      const { result } = ataskEnvelope(await run(["show", id, "--json"]), `show ${id}`);
      return taskOf(result, `show ${id}`);
    },
    async add(objective) {
      if (objective.project === undefined) return addWithProject(run, objective, []);
      // atask's own id form resolves itself; a name resolves against the registry it owns, and a name no
      // single registered project carries never reaches atask: it files into atask's own default project.
      const isId = PROJECT_ID.test(objective.project);
      const board = isId ? objective.project : await resolveProject(objective.project, projects);
      if (!isId && board === objective.project) {
        return fileIntoDefaultProject(run, objective, `no single atask project answers "${objective.project}"`);
      }
      try {
        return await addWithProject(run, objective, ["--project", board]);
      } catch (error) {
        if (!isProjectRejection(error)) throw error;
        return fileIntoDefaultProject(run, objective, messageOf(error));
      }
    },
  };
}

/** The task of one atask result: an id and a status, nothing guessed when either is missing. */
function taskOf(result: unknown, what: string): AtaskTask {
  const record = result as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null || typeof record.id !== "string" || typeof record.status !== "string") {
    throw new Error(`atask ${what} returned no task with an id and a status`);
  }
  return {
    id: record.id,
    status: record.status,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.warning === "string" ? { warning: record.warning } : {}),
  };
}

/**
 * Files the objective unscoped (into atask's own default project, the one an unscoped `atask add` lands in),
 * recording why the PM's project was substituted in the ticket's warning.
 */
async function fileIntoDefaultProject(run: RunAtask, objective: Objective, reason: string): Promise<AtaskTask> {
  const unscoped = await addWithProject(run, objective, []);
  const warning = [
    `atask refused the objective's project (${reason}); filed ${unscoped.id} into atask's default project`,
    ...(unscoped.warning === undefined ? [] : [unscoped.warning]),
  ].join("; ");
  return { ...unscoped, warning };
}

/** The registry, read through this port's own runner. */
function projectSource(run: RunAtask): ProjectsSource {
  return async () => {
    const listing = await run(["projects", "--json"]);
    if (listing.spawnError !== undefined) throw new Error(`atask CLI is not runnable: ${listing.spawnError}`);
    return projectsFromList(listing.stdout) as readonly AtaskProject[];
  };
}

async function addWithProject(run: RunAtask, objective: Objective, project: readonly string[]): Promise<AtaskTask> {
  const checks = objective.proof !== undefined && objective.regression !== undefined;
  const args = ["add", objective.title, ...project, "--json"];
  if (checks) args.push("--proof", objective.proof as string, "--regression", objective.regression as string);
  try {
    return addedOf(ataskEnvelope(await run(args), `add ${objective.title}`));
  } catch (error) {
    if (!checks || !isCheckRejection(error)) throw error;
    const draft = addedOf(
      ataskEnvelope(await run(["add", objective.title, ...project, "--json"]), `add ${objective.title} as a draft`),
    );
    const warning = [
      `atask rejected the objective's checks (${messageOf(error)}); filed ${draft.id} as a draft`,
      ...(draft.warning === undefined ? [] : [draft.warning]),
    ].join("; ");
    return { ...draft, warning };
  }
}

function addedOf(envelope: { result: unknown }): AtaskTask {
  const result = envelope.result as { task?: unknown; warnings?: unknown } | null;
  const task = result?.task as Record<string, unknown> | undefined;
  if (typeof task !== "object" || task === null || typeof task.id !== "string" || typeof task.status !== "string") {
    throw new Error("atask add returned no task with an id and a status");
  }
  const warnings = result?.warnings;
  const messages = typeof warnings === "object" && warnings !== null
    ? Object.values(warnings as Record<string, unknown>).flatMap((group) =>
      Array.isArray(group) ? group.filter((message): message is string => typeof message === "string") : [])
    : [];
  const base = { id: task.id, status: task.status };
  return messages.length === 0 ? base : { ...base, warning: messages.join("; ") };
}

function isCheckRejection(error: unknown): boolean {
  return error instanceof AtaskError && error.code === "INVALID_INPUT" && /check|proof|regression/i.test(error.message);
}

/** True when atask refused `--project` (unknown, gone, or ambiguous project), so the objective can still be filed unscoped. */
function isProjectRejection(error: unknown): boolean {
  return error instanceof AtaskError
    && /unknown project|project .* is ambiguous|no project with id or name/i.test(error.message);
}

/** Files every objective: a named atask id is read first, so a re-run files nothing twice. */
export async function fileObjectives(objectives: readonly Objective[], port: FilingPort): Promise<FiledObjective[]> {
  const filed: FiledObjective[] = [];
  for (const objective of objectives) filed.push(await fileOne(objective, port));
  return filed;
}

async function fileOne(objective: Objective, port: FilingPort): Promise<FiledObjective> {
  const base = {
    title: objective.title,
    ...(objective.project === undefined ? {} : { project: objective.project }),
    ...(objective.linear_link === undefined ? {} : { linear_link: objective.linear_link }),
  };
  let namedError: string | undefined;
  if (objective.atask_id !== undefined) {
    try {
      const task = await port.show(objective.atask_id);
      return { ...base, atask_id: task.id, status: task.status, filing: "existing" };
    } catch (error) {
      namedError = messageOf(error);
    }
  }
  try {
    const task = await port.add(objective);
    return {
      ...base,
      atask_id: task.id,
      status: task.status,
      filing: "created",
      ...(task.warning === undefined ? {} : { warning: task.warning }),
    };
  } catch (error) {
    const msg = messageOf(error);
    const failure = namedError === undefined ? msg : `${namedError}; filing by title also failed: ${msg}`;
    return { ...base, status: "unfiled", error: failure };
  }
}

/** One worker run for one objective id; rejections are the caller's to turn into a failed outcome. */
export type StartTask = (input: StartAtaskTaskInput) => Promise<StartAtaskTaskOutput>;

/** Dispatches every filed objective: one worker per ready one, serialized per project. */
export async function dispatchObjectives(filed: readonly FiledObjective[], start: StartTask): Promise<DelegatedObjective[]> {
  const delegated: DelegatedObjective[] = filed.map((objective) => {
    const skip = skipReason(objective);
    return skip === undefined ? { ...objective } : { ...objective, skip };
  });
  const ready = filed.flatMap((objective, index) =>
    objective.status === "ready" && objective.atask_id !== undefined ? [[objective, index] as const] : []);
  await Promise.all(groupByProjectLane(ready).map(async (queue) => {
    for (const [objective, index] of queue) {
      delegated[index] = { ...objective, delegated: await startTask(objective.atask_id as string, start) };
    }
  }));
  return delegated;
}

/** The project lanes of the ready objectives: one queue per project, an unscoped objective its own queue. */
export function groupByProjectLane(
  ready: ReadonlyArray<readonly [FiledObjective, number]>,
): ReadonlyArray<ReadonlyArray<readonly [FiledObjective, number]>> {
  const byProject = new Map<string, Array<readonly [FiledObjective, number]>>();
  const queues: Array<Array<readonly [FiledObjective, number]>> = [];
  for (const item of ready) {
    const project = item[0].project?.trim().toLowerCase();
    if (project === undefined || project === "") {
      queues.push([item]);
      continue;
    }
    let existing = byProject.get(project);
    if (existing === undefined) {
      existing = [];
      byProject.set(project, existing);
      queues.push(existing);
    }
    existing.push(item);
  }
  return queues;
}

function skipReason(objective: FiledObjective): string | undefined {
  if (objective.atask_id === undefined) return objective.error ?? "atask has no objective for this objective";
  if (objective.status === "ready") return undefined;
  if (objective.status === "draft") {
    return `atask filed ${objective.atask_id} as a draft: give it proof and regression, then dispatch it`;
  }
  if (objective.status === "claimed") {
    return `${objective.atask_id} is already claimed by another session; this run does not attach to it`;
  }
  if (objective.status === "unfiled") return objective.error ?? "atask refused this objective";
  return `${objective.atask_id} is ${objective.status}; only a ready objective starts a worker`;
}

async function startTask(id: string, start: StartTask): Promise<StartAtaskTaskOutput> {
  try {
    return await start(normalizeInput({ id }));
  } catch (error) {
    return { task_id: id, status: "failed", error: messageOf(error) };
  }
}

/**
 * One run's filing headline: the objectives atask accepted, and the ones it refused named behind them, never
 * a count that claims a filing atask rejected. An objective counts as filed when it carries an atask id that is
 * not a refusal.
 */
export function filingHeadline(filed: readonly FiledObjective[]): string {
  const accepted = filed.filter((objective) => objective.atask_id !== undefined && objective.status !== "unfiled").length;
  const via = "via the learn chain (forensics -> PM triage + review)";
  return accepted === filed.length
    ? `filed ${accepted} objective(s) ${via}`
    : `filed ${accepted} objective(s), ${filed.length - accepted} refused by atask, ${via}`;
}
