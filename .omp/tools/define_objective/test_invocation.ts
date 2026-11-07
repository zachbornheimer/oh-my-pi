import type { RunnerKind } from "./types.js";

/** What runs the tests: a runner the project has, or a project task that runs a set of them. */
export type InvocationRunner = RunnerKind | "js" | "mise" | "ci";

/** One test command of a check: what runs, where, and the packages, files or tasks it names. */
export interface TestInvocation {
  readonly runner: InvocationRunner;
  /** The directory below the project home the command ran in (a leading `cd`). */
  readonly dir: string;
  readonly targets: string[];
}

const PRESET_RUNNERS: Readonly<Record<string, InvocationRunner>> = {
  go_test: "go",
  js_test: "js",
  py_test: "pytest",
  rs_test: "cargo",
  php_test: "phpunit",
  ci: "ci",
};
const CHECK_SHAPE = /^([a-z_]+):\s*(.*)$/s;
const OPTION = /^[a-z_]+=/;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;
const QUOTES = /^["'`]|["'`]$/g;
const PACKAGE_MANAGERS = new Set(["aube", "pnpm", "yarn", "npm", "bun"]);
const EXECUTE_VERBS = new Set(["exec", "x", "dlx"]);
const TOOL_RUNNERS = new Set(["npx", "bunx"]);
const JS_RUNNERS = ["vitest", "jest"] as const;
const PYTHON_LAUNCHERS = [["python", "-m"], ["python3", "-m"], ["uv", "run"], ["poetry", "run"]] as const;
/** Flags whose next word is their value, not a test to run. */
const VALUE_FLAGS = new Set([
  "-run",
  "-count",
  "-timeout",
  "-tags",
  "-p",
  "-parallel",
  "-bench",
  "-cpu",
  "-coverprofile",
  "-o",
  "-t",
  "--testNamePattern",
  "--reporter",
  "--config",
  "-c",
  "--project",
  "--root",
  "--shard",
  "-k",
  "-m",
  "--maxfail",
  "--rootdir",
  "--ignore",
  "-n",
]);
/** Words that name the root of the tree: running them runs everything. */
const TREE_ROOTS = new Set([".", "./", "./...", "...", "*"]);
const WHOLE_SUITE_MISE_TASKS = new Set(["test", "ci", "check"]);
const WHOLE_SUITE_MAKE_TARGETS = new Set(["test", "tests", "check", "ci", "all"]);
const FILE_RUNNERS: ReadonlySet<InvocationRunner> = new Set([
  "go",
  "vitest",
  "jest",
  "js",
  "pytest",
  "cargo",
  "phpunit",
]);
const SUBCOMMAND_RUN = "run";
const PYTEST_ID_SEPARATOR = "::";

/** The words of `rest` that are not flags or flag values. */
function positional(rest: readonly string[]): string[] {
  const words: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]!;
    if (!word.startsWith("-")) words.push(word);
    else if (VALUE_FLAGS.has(word)) at++;
  }
  return words;
}

interface Head {
  readonly runner: InvocationRunner;
  readonly rest: string[];
}

function afterJsRunner(tools: readonly string[]): Head | undefined {
  const [tool, ...rest] = tools;
  if (!(JS_RUNNERS as readonly (string | undefined)[]).includes(tool)) return undefined;
  return { runner: tool as InvocationRunner, rest: rest[0] === SUBCOMMAND_RUN ? rest.slice(1) : rest };
}

function packageManagerHead([, verb, ...after]: readonly string[]): Head | undefined {
  if (verb !== undefined && EXECUTE_VERBS.has(verb)) return afterJsRunner(after);
  const script = verb === SUBCOMMAND_RUN ? after : [verb ?? "", ...after];
  const [name, ...rest] = script;
  return name === "test" || name === "ci" ? { runner: "npm", rest } : undefined;
}

function pytestHead(words: readonly string[]): Head | undefined {
  if (words[0] === "pytest") return { runner: "pytest", rest: words.slice(1) };
  const launcher = PYTHON_LAUNCHERS.find(([first, second]) => words[0] === first && words[1] === second);
  return launcher !== undefined && words[2] === "pytest" ? { runner: "pytest", rest: words.slice(3) } : undefined;
}

/** The test runner a shell command starts, or undefined for any other command. */
function headOf(words: readonly string[]): Head | undefined {
  const [first = "", second = ""] = words;
  if (first === "mise" && (second === "run" || second === "r")) return { runner: "mise", rest: words.slice(2) };
  if (first === "make") return { runner: "make", rest: words.slice(1) };
  if (first === "go" && second === "test") return { runner: "go", rest: words.slice(2) };
  if (first === "cargo" && second === "test") return { runner: "cargo", rest: words.slice(2) };
  if (first === "phpunit" || first.endsWith("/phpunit")) return { runner: "phpunit", rest: words.slice(1) };
  if (PACKAGE_MANAGERS.has(first)) return packageManagerHead(words);
  if (TOOL_RUNNERS.has(first)) return afterJsRunner(words.slice(1));
  return afterJsRunner(words) ?? pytestHead(words);
}

const joined = (dir: string, path: string): string => (dir === "" ? path : `${dir}/${path}`);

/** The test commands of a shell command line, following `cd` into the directory later commands run in. */
function shellInvocations(command: string): TestInvocation[] {
  const found: TestInvocation[] = [];
  let dir = "";
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(QUOTES, "")).filter((word) => word !== "");
    while (words.length > 0 && ENVIRONMENT_ASSIGNMENT.test(words[0]!)) words.shift();
    if (words[0] === "cd" && words[1] !== undefined) {
      dir = joined(dir, words[1].replace(/^\.\//, "").replace(/\/+$/, ""));
      continue;
    }
    const head = headOf(words);
    if (head !== undefined) found.push({ runner: head.runner, dir, targets: positional(head.rest) });
  }
  return found;
}

/** The test runs `check` (`"<preset>: <subject>"` or `"run: <command>"`) makes, in order. */
export function testInvocations(check: string): TestInvocation[] {
  const shape = CHECK_SHAPE.exec(check.trim());
  if (shape === null) return [];
  const [, preset, subject] = shape as unknown as [string, string, string];
  if (preset === "run") return shellInvocations(subject);
  const runner = PRESET_RUNNERS[preset];
  if (runner === undefined) return [];
  return [{ runner, dir: "", targets: subject.split(/\s+/).filter((word) => word !== "" && !OPTION.test(word)) }];
}

function runsEverything({ runner, targets }: TestInvocation): boolean {
  if (runner === "ci") return true;
  if (runner === "mise") return WHOLE_SUITE_MISE_TASKS.has(targets[0] ?? "");
  if (runner === "make") return targets.length === 0 || WHOLE_SUITE_MAKE_TARGETS.has(targets[0]!);
  const namesRoot = targets.some((target) => TREE_ROOTS.has(target));
  return runner === "go" ? namesRoot : namesRoot || targets.length === 0;
}

/** Whether `check` runs a project's whole suite (the `ci` preset, `mise run test|ci`, a runner given no file or package). */
export function namesWholeSuite(check: string): boolean {
  return testInvocations(check).some(runsEverything);
}

function targetPath(dir: string, target: string): string {
  const withoutId = target.split(PYTEST_ID_SEPARATOR)[0]!;
  const trimmed = withoutId.replace(/^(?:\.\/)+/, "").replace(/\/\.\.\.$/, "").replace(/\/+$/, "");
  return TREE_ROOTS.has(trimmed) || trimmed === "" || trimmed.startsWith("/") ? "" : joined(dir, trimmed);
}

/** The test runs of `check` that are given packages, directories or test files. */
export function fileTestInvocations(check: string): TestInvocation[] {
  return testInvocations(check).filter(({ runner }) => FILE_RUNNERS.has(runner));
}

/** The packages, directories and test files `invocation` runs, relative to the project home. */
export function invocationTargets({ dir, targets }: TestInvocation): string[] {
  return targets.map((target) => targetPath(dir, target)).filter((path) => path !== "");
}

/** The packages, directories and test files `check` runs, relative to the project home. */
export function testTargets(check: string): string[] {
  return fileTestInvocations(check).flatMap(invocationTargets);
}
