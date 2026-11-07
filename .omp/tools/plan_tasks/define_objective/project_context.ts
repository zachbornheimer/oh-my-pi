import { groundingProblems } from "./checked_paths.js";
import type { OpenTask, ProjectContext, TaskSpec } from "./types.js";

/** An open task shorter than this (normalized) is too generic to say two goals are the same. */
const MIN_DUPLICATE_LENGTH = 12;
const MORE_NOT_SHOWN = " …";

const squashed = (text: string): string => text.trim().replace(/\s+/g, " ");
const bareLint = (check: string): boolean => /^lint:?$/.test(squashed(check));

/** The lines of the brief that show the writer what is really in the project's checkout. */
export function contextLines(context: ProjectContext): string[] {
  const unlisted = new Set(context.Unlisted);
  const files = context.Layout.map((path) => `${path}${unlisted.has(path.replace(/\/$/, "")) ? MORE_NOT_SHOWN : ""}`);
  if (unlisted.has("")) files.push("…");
  return [
    `Project files (a trailing / marks a directory; … marks a listing that is cut short):\n${files.join("\n")}`,
    `Mise tasks: ${context.MiseTasks.join(", ") || "none"}`,
    context.OpenTasks.length === 0
      ? "Open tasks already filed: none"
      : `Open tasks already filed (do not repeat them):\n${
        context.OpenTasks.map((task) => `- ${task.id} ${task.title}`).join("\n")
      }`,
  ];
}

const comparable = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The id of the open task whose title says the same as `outcome` (one contains the other, ignoring case and punctuation). */
export function duplicateOf(outcome: string, open: readonly OpenTask[]): string | undefined {
  const wanted = comparable(outcome);
  return open.find((task) => {
    const title = comparable(task.title);
    return title.length >= MIN_DUPLICATE_LENGTH && (wanted.includes(title) || title.includes(wanted));
  })?.id;
}

/** What is wrong with a task spec once the project is known: paths or mise tasks its checks name that the project does not have. */
export function groundedSpecProblems(spec: TaskSpec, context: ProjectContext): string[] {
  return [
    ...groundingProblems("proof", spec.proof, context),
    ...groundingProblems("regression", spec.regression, context),
  ];
}

/** Why a regression is refused whatever the project: empty, or the bare lint preset. */
export function regressionProblems(regression: string): string[] {
  if (squashed(regression) === "") return ["regression is empty"];
  return bareLint(regression)
    ? [
      "regression \"lint:\" is the bare lint preset, which does not test this change: use a test command that covers it, such as \"go_test: ./pkg\"",
    ]
    : [];
}
