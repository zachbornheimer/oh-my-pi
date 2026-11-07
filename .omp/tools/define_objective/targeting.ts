import { miseTasksRunBy, pathsNamedBy } from "./checked_paths.js";
import { CHECK_SIZES, type CheckSize, type ProjectContext, type Runner, type TaskSpec } from "./types.js";
import { taskSpecProblems, titleProblems } from "./atask_grammar.js";
import { crossCuttingReason } from "./cross_cutting.js";
import type { ObjectiveReply, Targeting } from "./types.js";
import { miseTestTasksNearGoal, NEAR_GOAL_LIMIT, scoredNearGoal, testIndexNearGoal } from "./test_index.js";
import {
  fileTestInvocations,
  invocationTargets,
  namesWholeSuite,
  type TestInvocation,
  testInvocations,
  testTargets,
} from "./test_invocation.js";

/** The goal, the project's checkout and the files the work changes: everything a check is aimed with. */
export interface Scene {
  readonly goal: string;
  readonly context?: ProjectContext | undefined;
  readonly changedFiles: readonly string[];
}

const WHOLE_SUITE = "whole suite";
const NO_RUNNER = "none";
const SUGGESTION_LIMIT = 5;
/** A test file sharing this many words with the goal is the test of its area: a proof can be written against it. */
const STRONG_MATCH_SCORE = 2;
const SIZE_OPTION = /(?:^|\s)size=/;
/** Presets whose default time class is longer than small (`atask help add`). */
const PRESET_SIZE: Readonly<Record<string, CheckSize>> = {
  build: "medium",
  lint: "medium",
  playwright_run: "medium",
  rs_test: "medium",
  ci: "large",
};
const CHECK_PRESET = /^\s*([a-z_]+):/;

const directoryOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const knownTestFiles = (scene: Scene): string[] => scene.context?.TestFiles ?? [];
const nearGoal = (scene: Scene): string[] => testIndexNearGoal(knownTestFiles(scene), scene.goal, scene.changedFiles);

/** The test files near the goal that the writer is shown. */
export const testFilesNearGoal = nearGoal;

function presetSize(check: string): CheckSize {
  return PRESET_SIZE[CHECK_PRESET.exec(check)?.[1] ?? ""] ?? "small";
}

const longer = (a: CheckSize, b: CheckSize): CheckSize => CHECK_SIZES.indexOf(a) >= CHECK_SIZES.indexOf(b) ? a : b;

/**
 * Both checks with their `size=`: the proof gets its preset's time class (small unless the preset is slower), the
 * regression the size the writer chose, never less than its preset needs.
 */
export function sizedChecks(reply: ObjectiveReply): { proof: string; regression: string } {
  const chosen = (CHECK_SIZES as readonly string[]).includes(reply.regression_size)
    ? reply.regression_size as CheckSize
    : "small";
  return {
    proof: `${reply.proof.trim()} size=${presetSize(reply.proof)}`,
    regression: `${reply.regression.trim()} size=${longer(presetSize(reply.regression), chosen)}`,
  };
}

/** Whether a listed test file holds `target` (it is that file, or a directory or package above it). */
const holdsTests = (files: readonly string[], target: string): boolean =>
  files.some((file) => file === target || file.startsWith(`${target}/`));

/** The tests a check runs that the project's test files do not hold; none can be told when the list was cut short or never read. */
function unknownTestTargets(check: string, context: ProjectContext | undefined): string[] {
  const files = context?.TestFiles;
  if (files === undefined || context?.TestFilesTruncated === true) return [];
  return testTargets(check).filter((target) => !holdsTests(files, target));
}

function unknownTargetProblems(label: string, check: string, scene: Scene): string[] {
  const near = nearGoal(scene).slice(0, SUGGESTION_LIMIT);
  const listed = near.length === 0
    ? "none of the project's test files is near this goal"
    : `near this goal: ${near.join(", ")}`;
  return unknownTestTargets(check, scene.context).map((target) =>
    `${label} runs tests at "${target}", which holds no test file listed for the project (${listed})`
  );
}

const placeOf = (dir: string): string => dir === "" ? "the project root" : dir;

/** The runner whose config governs `path`: of its kind, in the deepest directory that contains it. */
function runnerOwning(invocation: TestInvocation, path: string, context: ProjectContext): Runner | undefined {
  const kinds: readonly string[] = invocation.runner === "js" ? ["vitest", "jest"] : [invocation.runner];
  return (context.Runners ?? [])
    .filter((runner) => kinds.includes(runner.Kind) && (runner.Dir === "" || path.startsWith(`${runner.Dir}/`)))
    .sort((a, b) => b.Dir.length - a.Dir.length)[0];
}

/** Tests run from a directory other than the one their runner's config is in (a nested Go module, a vitest config one level down). */
function runnerDirectoryProblems(label: string, check: string, context: ProjectContext | undefined): string[] {
  if (context === undefined) return [];
  return fileTestInvocations(check).flatMap((invocation) =>
    invocationTargets(invocation).flatMap((path) => {
      const owner = runnerOwning(invocation, path, context);
      if (owner === undefined || owner.Dir === invocation.dir) return [];
      const fix = owner.Dir === ""
        ? "run it from the project root, without cd"
        : `write "run: cd ${owner.Dir} && ${owner.Command} <path relative to ${owner.Dir}>"`;
      return [
        `${label} runs ${owner.Kind} tests of "${path}" from ${
          placeOf(invocation.dir)
        }, but their ${owner.Kind} config is in ${placeOf(owner.Dir)}: ${fix}`,
      ];
    })
  );
}

const testRunProblems = (label: string, check: string, scene: Scene): string[] => [
  ...unknownTargetProblems(label, check, scene),
  ...runnerDirectoryProblems(label, check, scene.context),
];

const sizeWrittenProblems = (label: string, check: string): string[] =>
  SIZE_OPTION.test(check) ? [`${label} must not carry size=: the size is set from its time class`] : [];

function proofProblems(reply: ObjectiveReply, scene: Scene): string[] {
  if (namesWholeSuite(reply.proof)) {
    return [
      `proof "${reply.proof.trim()}" runs a whole suite, which cannot finish in 30 seconds or show this goal is met: run the one test file, package or test name that does`,
    ];
  }
  return [...sizeWrittenProblems("proof", reply.proof), ...testRunProblems("proof", reply.proof, scene)];
}

const dedupe = (items: readonly string[]): string[] => [...new Set(items)];

/** What would cover the work more narrowly than the whole suite: the proof's package or directory, nearby tests, area tasks. */
function narrowerRegressions(reply: ObjectiveReply, scene: Scene): string[] {
  const proofTargets = testTargets(reply.proof);
  const beside = proofTargets.map((target) => /\.[A-Za-z0-9]+$/.test(target) ? directoryOf(target) : target);
  const others = nearGoal(scene).filter((file) => !proofTargets.includes(file));
  const proofTasks = new Set(miseTasksRunBy(reply.proof));
  const areaTasks = miseTestTasksNearGoal(scene.context?.MiseTasks ?? [], scene.goal, scene.changedFiles)
    .filter((task) => task.startsWith("test:") && !proofTasks.has(task)).map((task) => `mise run ${task}`);
  return dedupe([...beside.filter((path) => path !== ""), ...others, ...areaTasks]).slice(0, SUGGESTION_LIMIT);
}

function regressionScopeProblems(reply: ObjectiveReply, scene: Scene): string[] {
  if (!namesWholeSuite(reply.regression)) {
    return reply.regression_size === "large"
      ? [
        "regression_size \"large\" is for the whole suite of a cross-cutting goal: a regression that names tests fits small or medium",
      ]
      : [
        ...sizeWrittenProblems("regression", reply.regression),
        ...testRunProblems("regression", reply.regression, scene),
      ];
  }
  const problems = reply.regression_size === "large" ? [] : ["a whole-suite regression must be size \"large\""];
  const narrower = narrowerRegressions(reply, scene);
  if (crossCuttingReason(scene.goal, scene.changedFiles) === undefined && narrower.length > 0) {
    problems.push(
      `regression runs the whole suite, but this work is narrower: run the tests of what it touches instead (${
        narrower.join(" | ")
      })`,
    );
  }
  return problems;
}

const taskSpecOf = (reply: ObjectiveReply): TaskSpec => ({
  title: reply.title,
  proof: reply.proof,
  regression: reply.regression,
  size: reply.regression_size,
  rationale: reply.rationale,
});

function draftProblems(reply: ObjectiveReply, scene: Scene): string[] {
  const strongest = scoredNearGoal(knownTestFiles(scene), scene.goal, scene.changedFiles)[0];
  return [
    ...(reply.draft_reason.trim() === "" ? ["draft_reason is empty: say why no targeted proof could be grounded"] : []),
    ...(strongest !== undefined && strongest.score >= STRONG_MATCH_SCORE
      ? [
        `draft is refused: ${strongest.path} is the test of this goal's area, so write the proof against it (the work adds or changes the test there)`,
      ]
      : []),
  ];
}

function wordingProblems(reply: ObjectiveReply): string[] {
  const problems: string[] = [];
  if (reply.outcome.trim() === "") problems.push("outcome is empty");
  if (reply.acceptance.length === 0 || reply.acceptance.some((line) => line.trim() === "")) {
    problems.push("acceptance is empty: list what must be true");
  }
  return problems;
}

/**
 * Everything wrong with a written objective, in words for the model; empty when it can be filed. A draft needs a
 * reason and no checks. Otherwise both checks must be in atask's grammar and name things the project has (a
 * proof that runs a whole suite is refused, not resized), and the regression must cover no more than the work touches
 * unless the work is cross-cutting.
 */
export function objectiveProblems(reply: ObjectiveReply, scene: Scene): string[] {
  const wording = wordingProblems(reply);
  if (reply.draft) {
    return [
      ...titleProblems(reply.title),
      ...wording,
      ...draftProblems(reply, scene),
      ...(reply.rationale.trim() === "" ? ["rationale is empty"] : []),
    ];
  }
  return [
    ...wording,
    ...taskSpecProblems(taskSpecOf(reply), scene.context),
    ...proofProblems(reply, scene),
    ...regressionScopeProblems(reply, scene),
  ];
}

/** The objective itself when it can be filed; otherwise throws the problems as one reason the model is shown on the retry. */
export function checkObjective(reply: ObjectiveReply, scene: Scene): ObjectiveReply {
  const problems = objectiveProblems(reply, scene);
  if (problems.length > 0) throw new Error(`fix the answer: ${problems.join("; ")}`);
  return reply;
}

function runnerOf(proof: string): string {
  return testInvocations(proof)[0]?.runner ?? NO_RUNNER;
}

/** The listed test file the proof runs, else the most relevant one in the package or directory it runs. */
function chosenTest(proof: string, scene: Scene): string {
  const files = knownTestFiles(scene);
  const named = pathsNamedBy(proof, scene.context?.Home ?? "").find((path) => files.includes(path));
  if (named !== undefined) return named;
  const targets = testTargets(proof);
  return nearGoal(scene).find((file) => targets.some((target) => directoryOf(file) === target)) ?? "";
}

function chosenScope(regression: string, home: string): string {
  if (namesWholeSuite(regression)) return WHOLE_SUITE;
  const targets = testTargets(regression);
  if (targets.length > 0) return targets.join(" ");
  const tasks = miseTasksRunBy(regression).map((task) => `mise run ${task}`);
  return (tasks.length > 0 ? tasks : pathsNamedBy(regression, home)).join(" ");
}

/** How the checks were aimed, derived from what the objective runs rather than from what the writer says. */
export function targetingOf(reply: ObjectiveReply, scene: Scene): Targeting {
  return {
    runner: reply.draft ? NO_RUNNER : runnerOf(reply.proof),
    changed_paths: [...scene.changedFiles],
    test_files_considered: nearGoal(scene).slice(0, NEAR_GOAL_LIMIT),
    chosen_test: reply.draft ? "" : chosenTest(reply.proof, scene),
    chosen_scope: reply.draft ? "" : chosenScope(reply.regression, scene.context?.Home ?? ""),
  };
}
