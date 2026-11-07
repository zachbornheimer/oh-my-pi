/** The types the objective rules share. Plain TypeScript: the checks are made in code, never by a schema library. */

/**
 * The time class a check carries as `size=` in atask: small (30s), medium (300s), large (900s). A fourth class,
 * eternal, has no budget and is never chosen for a written check.
 */
export const CHECK_SIZES = ["small", "medium", "large"] as const;
export type CheckSize = (typeof CHECK_SIZES)[number];

export const RUNNER_KINDS = ["go", "vitest", "jest", "npm", "pytest", "cargo", "phpunit", "make"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** An atask task of the project that is not finished: what the writer must not file a second time. */
export interface OpenTask {
  id: string;
  title: string;
}

/**
 * A way the checkout runs its tests, read from its config files. `Dir` is the directory below the home the command
 * runs in ("" is the home itself). `Command` runs the tests named after it ("go test", "aube exec vitest run").
 * `Detail` is what else the config says: the Go module path, the make targets.
 */
export interface Runner {
  Kind: RunnerKind;
  Dir: string;
  Command: string;
  Detail: string;
}

/**
 * What is known of one project's checkout, so a proof can name a file or task that exists.
 * `Home` is its directory. `Layout` lists paths relative to the home, a directory with a trailing `/`. `Unlisted`
 * names the directories ("" is the home itself) whose children are not all in `Layout`: a path below one cannot be
 * disproven. `MiseTasks` are the `[tasks.*]` names of its mise.toml; `OpenTasks` its unfinished atask tasks.
 * The rest is absent when the checkout was not read for it: `Runners`; `TestFiles` (tracked, most relevant to the
 * goal first, cut at a cap `TestFilesTruncated` reports); `TestNames` (found in the most relevant files);
 * `ChangedFiles`.
 */
export interface ProjectContext {
  Home: string;
  Layout: string[];
  Unlisted: string[];
  MiseTasks: string[];
  OpenTasks: OpenTask[];
  Runners?: Runner[];
  TestFiles?: string[];
  TestFilesTruncated?: boolean;
  TestNames?: Record<string, string[]>;
  ChangedFiles?: string[];
}

/** What the objective writer is shown of the project besides its checkout. */
export interface ProjectRecord {
  Name: string;
  Home: string;
  Goal: string;
}

/** The project the objective belongs to. */
export interface PlannedProject {
  /** The atask project id; empty when none is known. */
  id: string;
  name: string;
  /** Always false here: `plan_tasks`'s select_project step is not part of this tool. */
  needsNewProject: boolean;
}

/** A proof and a regression with the title and size they are filed under (what `atask add` takes). */
export interface TaskSpec {
  title: string;
  proof: string;
  regression: string;
  size: string;
  rationale: string;
}

/** What the model writes for one goal. Checks are written without `size=`. */
export interface ObjectiveReply {
  title: string;
  outcome: string;
  acceptance: string[];
  draft: boolean;
  draft_reason: string;
  proof: string;
  regression: string;
  regression_size: string;
  rationale: string;
}

/** How the checks were aimed: the runner, the files the work changes, the tests considered, and what was chosen. */
export interface Targeting {
  /** The runner of the proof: "go", "vitest", "pytest", "mise" ..., or "none" for a check that runs no test runner. */
  runner: string;
  changed_paths: string[];
  /** The test files near the goal that the writer was shown. */
  test_files_considered: string[];
  /** The test file the proof runs; empty when it runs none. */
  chosen_test: string;
  /** What the regression covers: the packages or paths it names, a mise task, or "whole suite". */
  chosen_scope: string;
}

export interface DefinedObjective {
  title: string;
  outcome: string;
  acceptance: string[];
  /** `PRESET: SUBJECT size=small|medium|large`; empty for a draft. */
  proof: string;
  /** Empty for a draft. */
  regression: string;
  /** Always empty: what an objective waits for is the plan's to say. */
  requires: string[];
  rationale: string;
  targeting: Targeting;
  /** True when no targeted proof could be grounded: file it as a draft, without checks. */
  draft: boolean;
  draft_reason?: string;
  /** The id of an open atask task that already states this goal. */
  duplicate_of?: string;
  project: PlannedProject;
  /** Always empty: this tool files nothing. */
  applied: string;
}
