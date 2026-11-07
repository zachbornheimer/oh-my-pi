import { contextLines } from "./project_context.js";
import type { ProjectContext, ProjectRecord, Runner } from "./types.js";
import { crossCuttingReason } from "./cross_cutting.js";
import { type Scene, testFilesNearGoal } from "./targeting.js";
import { miseTestTasksNearGoal } from "./test_index.js";

const UNKNOWN = "unknown";
const NAMES_SHOWN_PER_FILE = 15;

function projectLines(name: string, record: ProjectRecord | undefined): string[] {
  return [
    `Project: ${name || UNKNOWN}`,
    `Project home: ${record?.Home || UNKNOWN}`,
    `Project goal: ${record?.Goal || UNKNOWN}`,
  ];
}

function runnerLine(runner: Runner): string {
  const where = runner.Dir === "" ? "the project root" : `${runner.Dir}/ (run it after "cd ${runner.Dir} &&")`;
  return `- ${runner.Kind} in ${where}${runner.Detail === "" ? "" : ` (${runner.Detail})`}: ${runner.Command}`;
}

function testLines(context: ProjectContext, scene: Scene): string[] {
  const listed = context.TestFiles ?? [];
  const runners = context.Runners ?? [];
  const near = testFilesNearGoal(scene);
  const cut = context.TestFilesTruncated === true ? "; the list is cut short" : "";
  const tasks = miseTestTasksNearGoal(context.MiseTasks, scene.goal, scene.changedFiles);
  return [
    tasks.length === 0 ? "Mise test tasks near the goal: none" : `Mise test tasks near the goal: ${tasks.join(", ")}`,
    runners.length === 0 ? "Test runners: none detected" : `Test runners:\n${runners.map(runnerLine).join("\n")}`,
    near.length === 0
      ? `Test files near the goal: none (${listed.length} test files listed${cut})`
      : `Test files near the goal (${near.length} of ${listed.length} listed${cut}):\n${
        near.map((file) => {
          const names = (context.TestNames?.[file] ?? []).slice(0, NAMES_SHOWN_PER_FILE);
          return names.length === 0 ? file : `${file} [tests: ${names.join(", ")}]`;
        }).join("\n")
      }`,
  ];
}

/** What the model reads to write the objective for one goal: the project, its files and tests, the changes, the goal and its siblings. */
export function objectiveBrief(
  scene: Scene,
  project: { readonly name: string; readonly record: ProjectRecord | undefined },
  alongside: readonly string[],
): string {
  const crossing = crossCuttingReason(scene.goal, scene.changedFiles);
  return [
    ...projectLines(project.name, project.record),
    ...(scene.context === undefined ? [] : [...contextLines(scene.context), ...testLines(scene.context, scene)]),
    scene.changedFiles.length === 0
      ? "Changed files: none given"
      : `Changed files:\n${scene.changedFiles.join("\n")}`,
    crossing === undefined ? "Cross-cutting: no" : `Cross-cutting: yes (${crossing})`,
    `The goal: ${scene.goal}`,
    alongside.length === 0
      ? "Other goals alongside: none"
      : `Other goals alongside (not part of this one):\n${alongside.map((goal) => `- ${goal}`).join("\n")}`,
  ].join("\n");
}
