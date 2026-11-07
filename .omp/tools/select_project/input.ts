import type { Contents, ProjectRecord, SelectProjectInput, Turn } from "./types.js";

/** The most bytes of the project list the thread shows (agentmux session.DefaultSubjectBudget). */
export const DEFAULT_SUBJECT_BUDGET = 16 * 1024;

type Raw = Record<string, unknown>;

function record(value: unknown, where: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Raw;
}

/** A string field; absent or null is the default "", anything else that is not a string is refused naming the field. */
function text(raw: Raw, key: string, where: string): string {
  const value = raw[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${where}${key} must be a string`);
  return value;
}

function contentsOf(value: unknown, where: string): Contents {
  if (value === undefined || value === null) return { Entries: [], Readme: "" };
  const raw = record(value, `${where}Contents`);
  const entries = raw.Entries ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where}Contents.Entries must be an array of strings`);
  }
  return { Entries: entries as string[], Readme: text(raw, "Readme", `${where}Contents.`) };
}

function projectOf(value: unknown, where: string): ProjectRecord {
  const raw = record(value, where);
  const prefix = `${where}.`;
  if (typeof raw.Name !== "string") throw new Error(`${prefix}Name must be a string`);
  return {
    ID: text(raw, "ID", prefix),
    Name: raw.Name,
    Goal: text(raw, "Goal", prefix),
    Summary: text(raw, "Summary", prefix),
    Home: text(raw, "Home", prefix),
    Contents: contentsOf(raw.Contents, prefix),
  };
}

function turnOf(value: unknown, index: number): Turn {
  const raw = record(value, `Turns[${index}]`);
  if (typeof raw.Role !== "string") throw new Error(`Turns[${index}].Role must be a string`);
  if (typeof raw.Text !== "string") throw new Error(`Turns[${index}].Text must be a string`);
  return { Role: raw.Role, Text: raw.Text };
}

/**
 * The thread the caller gathered, with every default filled in. Throws, naming the field, on a wrong type or an
 * empty `Turns`; nothing is read from disk.
 */
export function selectProjectInput(params: unknown): SelectProjectInput {
  const raw = record(params, "the input");
  if (!Array.isArray(raw.Turns) || raw.Turns.length === 0) throw new Error("Turns must have at least one turn");
  const projects = raw.Projects ?? [];
  if (!Array.isArray(projects)) throw new Error("Projects must be an array");
  const budget = raw.ProjectBudget;
  if (budget !== undefined && budget !== null && (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0)) {
    throw new Error("ProjectBudget must be a positive integer");
  }
  return {
    WorkDir: text(raw, "WorkDir", ""),
    Repo: text(raw, "Repo", ""),
    Worktree: text(raw, "Worktree", ""),
    Branch: text(raw, "Branch", ""),
    Title: text(raw, "Title", ""),
    FirstRequest: text(raw, "FirstRequest", ""),
    Turns: raw.Turns.map(turnOf),
    ...(raw.Current === undefined || raw.Current === null ? {} : { Current: projectOf(raw.Current, "Current") }),
    Projects: projects.map((project, index) => projectOf(project, `Projects[${index}]`)),
    ...(typeof budget === "number" ? { ProjectBudget: budget } : {}),
  };
}
