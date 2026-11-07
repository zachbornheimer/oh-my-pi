import type { Machine } from "./define_objective/machine.js";
import type { AppliedItem, PlannedItem, PlanTasksResult } from "./types.js";

const JSON_OUTPUT = { ATASK_OUTPUT: "json" } as const;

export const NEW_PROJECT_MESSAGE = "no project fits this work: run `atask init` in the repo first, then plan again";

/** The exact `atask add` arguments that file `item` into `projectRef`; `requiredIds` are the atask ids it waits for. */
export function ataskAddArguments(projectRef: string, item: PlannedItem, requiredIds: readonly string[]): string[] {
  return [
    "add",
    "--project",
    projectRef,
    item.title,
    "--outcome",
    item.outcome,
    ...item.acceptance.flatMap((line) => ["--accept", line]),
    ...(item.draft ? [] : ["--proof", item.proof, "--regression", item.regression]),
    ...requiredIds.flatMap((id) => ["--requires", id]),
  ];
}

const filed = (applied: readonly AppliedItem[]): string =>
  applied.length === 0 ? "nothing filed yet" : `already filed: ${applied.map((item) => `${item.key}=${item.id}`).join(", ")}`;

/** Files one item with `atask add` and returns the new task's id. A refusal names the item, what atask said and what was already filed. */
async function fileItem(
  machine: Machine,
  projectRef: string,
  item: PlannedItem,
  requiredIds: readonly string[],
  applied: readonly AppliedItem[],
): Promise<string> {
  const label = `${item.key} ${JSON.stringify(item.title)}`;
  const added = await machine.run("atask", ataskAddArguments(projectRef, item, requiredIds), JSON_OUTPUT);
  if (added.code !== 0) {
    const said = added.stderr.trim() || added.stdout.trim();
    throw new Error(`\`atask add\` for ${label} failed (exit ${added.code}): ${said}; ${filed(applied)}`);
  }
  try {
    const parsed = JSON.parse(added.stdout) as { ok?: unknown; result?: { task?: { id?: unknown } } };
    const id = parsed.result?.task?.id;
    if (parsed.ok !== true || typeof id !== "string" || id === "") throw new Error("expected { ok: true, result: { task: { id } } }");
    return id;
  } catch (error) {
    throw new Error(`\`atask add\` for ${label} did not print the new task: ${(error as Error).message}; ${filed(applied)}`);
  }
}

/**
 * Files the planned items with `atask add`, in plan order so every `--requires` names an item already filed, and
 * returns the plan with `applied` set. An item that duplicates an open task is not filed: whatever waits for it waits
 * for that task instead. Refuses a plan that has no project to file into. A failing `atask add` stops the run and
 * names the ids already filed.
 */
export async function applyPlan(plan: PlanTasksResult, machine: Machine): Promise<PlanTasksResult> {
  if (plan.project.needsNewProject) throw new Error(NEW_PROJECT_MESSAGE);
  const projectRef = plan.project.id || plan.project.name;
  if (projectRef === "") throw new Error("the plan names no project to file into: run `atask init` in the repo first");
  const applied: AppliedItem[] = [];
  const idsByKey = new Map<string, string>();
  for (const item of plan.items) {
    if (item.duplicate_of !== undefined) {
      idsByKey.set(item.key, item.duplicate_of);
      continue;
    }
    const requiredIds = item.requires.map((key) => {
      const id = idsByKey.get(key);
      if (id === undefined) throw new Error(`item ${item.key} requires ${key}, which was not filed before it`);
      return id;
    });
    const id = await fileItem(machine, projectRef, item, requiredIds, applied);
    idsByKey.set(item.key, id);
    applied.push({ key: item.key, id });
  }
  return { ...plan, applied };
}
