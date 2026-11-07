import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { isWorkflowName, WORKFLOW_NAME_MESSAGE, type Workflow } from "./schemas.ts";

const SKILLS_DIRECTORY = ".agents/available-skills";
const SKILL_FILE = "SKILL.md";

/** The SKILL.md a workflow named `name` is written to. */
export const skillPath = (home: string, name: string): string => join(home, SKILLS_DIRECTORY, name, SKILL_FILE);

/**
 * Writes the workflow's SKILL.md to `<home>/.agents/available-skills/<name>/SKILL.md` and returns the workflow with
 * `applied`. The name must be lower-case words joined by hyphens, so the path cannot leave that directory. An existing
 * file is never overwritten: it is reported with `outcome: "exists"` and nothing is written. The file is created with the
 * exclusive flag, so one that appears between the check and the write is not overwritten either.
 */
export async function applyWorkflow<T extends Workflow>(workflow: T, home: string): Promise<T> {
  if (!isWorkflowName(workflow.name)) {
    throw new Error(`derive_workflow: cannot apply, the name "${workflow.name}" ${WORKFLOW_NAME_MESSAGE}`);
  }
  const path = skillPath(home, workflow.name);
  await mkdir(join(home, SKILLS_DIRECTORY, workflow.name), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ...workflow, applied: { path, outcome: "exists" } };
    throw new Error(`writing ${path} failed: ${(error as Error).message}; nothing was written`);
  }
  try {
    await handle.writeFile(workflow.skill_markdown, "utf8");
  } finally {
    await handle.close();
  }
  return { ...workflow, applied: { path, outcome: "written" } };
}
