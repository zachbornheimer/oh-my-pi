import type { ProjectRecord, Selected } from "./types.js";

/** The menu entry that says no live project can hold the work (agentmux project.NewProjectChoice). */
export const NEW_PROJECT_CHOICE = "new";

/** The field the one question is answered under (agentmux project.Selection.Project). */
export const PROJECT_FIELD = "Project";

/** What the one question asks, and when `new` is the answer (agentmux `internal/project` question, copied unchanged). */
export const PROJECT_INSTRUCTIONS = `Which live project does the work in this conversation belong to?
Judge primarily from what the conversation is actually working on: the
repositories, files, services, and products it names and edits, matched
against each project's facts. Each project is shown by its home
directory (the repository its sessions ran in) and what is in it: its
top-level files and folders and the opening of its README. Match the
work in the conversation against those facts: repository names,
packages, files, and tools the conversation mentions. A name alone
says little; trust the home and contents over the name.
The session directory and its repository are supporting evidence only,
because a session is sometimes started in the wrong directory. When the
conversation clearly works on a different project than its directory
suggests, follow the conversation.
A git worktree, a branch, or a spec or feature folder belongs to the
project of the repository it comes from. Never pick a project because its
name resembles a worktree, branch, or folder name. Match the repository
first, then the work described.
"Currently filed under" is only where the thread happens to be filed, and
it can be wrong; it is not a default. Choose it only when the conversation
genuinely fits that project, and leave it when another project fits
clearly better, even when the thread has been filed there for a long time.
A project that matches only on a similar word does not fit.
Choose new only when no live project fits this work.`;

export const NEW_PROJECT_CRITERIA = "No live project fits this work: it is a distinct, durable body of work that needs a project of its own.";

/** The names of the live projects, without blanks and without repeats (a name is the menu entry's identity). */
export function menuNames(projects: readonly ProjectRecord[]): string[] {
  const names: string[] = [];
  for (const project of projects) {
    const name = project.Name.trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Refuses a live project named `new`: its menu entry could not be told from the entry for a new project. */
export function refuseReservedName(names: readonly string[]): void {
  if (names.includes(NEW_PROJECT_CHOICE)) {
    throw new Error(`a live project is named "${NEW_PROJECT_CHOICE}", which is the menu's own entry for a new project: rename it`);
  }
}

/** Refuses a choice that is neither a live project name nor "new". The message is written for the model to act on. */
export function chosenFrom(choice: string, names: readonly string[]): void {
  if (choice === NEW_PROJECT_CHOICE || names.includes(choice)) return;
  const menu = names.map((name) => JSON.stringify(name)).join(" ");
  throw new Error(
    `project ${JSON.stringify(choice)} is not on the menu: choose one of [${menu}] or "${NEW_PROJECT_CHOICE}"`,
  );
}

/** The project the choice names, with the id of the live project of that name and the model's stated confidence. */
export function selected(choice: string, projects: readonly ProjectRecord[] = [], confidence: number | null = null): Selected {
  if (choice === NEW_PROJECT_CHOICE) return { ProjectName: "", ProjectID: "", NeedsNewProject: true, Confidence: confidence };
  const live = projects.find((project) => project.Name.trim() === choice);
  return { ProjectName: choice, ProjectID: live?.ID ?? "", NeedsNewProject: false, Confidence: confidence };
}
