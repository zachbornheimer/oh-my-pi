import type { Machine } from "./machine.js";
import type { Runner } from "./types.js";

/** The most directories below the project root that are looked in for a runner. */
export const RUNNER_DIRECTORY_LIMIT = 16;

const TEST_DIRECTORIES = new Set(["test", "tests", "spec"]);
const GO_MODULE = /^module\s+(\S+)/m;
const MAKE_TEST_TARGET = /^(test[\w-]*|check|ci):/gm;
const PYTEST_CONFIGURED = /pytest/;
const PYTHON_CONFIG_FILES = ["pyproject.toml", "setup.cfg", "tox.ini"] as const;
const PHPUNIT_CONFIG_FILES = ["phpunit.xml", "phpunit.xml.dist"] as const;
const DEFAULT_PACKAGE_MANAGER = "npm";

/** How each JavaScript package manager runs a tool from the project (`exec`) and one of its scripts (`script`). */
const PACKAGE_MANAGER_COMMANDS: Readonly<Record<string, { exec: string; script: string }>> = {
  aube: { exec: "aube exec", script: "aube run" },
  pnpm: { exec: "pnpm exec", script: "pnpm run" },
  yarn: { exec: "yarn", script: "yarn" },
  bun: { exec: "bunx", script: "bun run" },
  npm: { exec: "npx", script: "npm run" },
};

/** The parts of a package.json a runner is read from. */
interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === "string");

/** A package.json read for its runner; undefined when it is not an object of the expected shape. */
function parsePackageJson(text: string): PackageJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { packageManager, scripts, dependencies, devDependencies } = parsed as Record<string, unknown>;
  if (packageManager !== undefined && typeof packageManager !== "string") return undefined;
  for (const field of [scripts, dependencies, devDependencies]) {
    if (field !== undefined && !isStringRecord(field)) return undefined;
  }
  return { packageManager, scripts, dependencies, devDependencies } as PackageJson;
}

const at = (home: string, dir: string, name: string): string =>
  dir === "" ? `${home}/${name}` : `${home}/${dir}/${name}`;

async function javascriptRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  const text = await machine.readTextFile(at(home, dir, "package.json"));
  if (text === undefined) return [];
  const parsed = parsePackageJson(text);
  if (parsed === undefined) return [];
  const manager = parsed.packageManager?.split("@")[0] ?? DEFAULT_PACKAGE_MANAGER;
  const commands = PACKAGE_MANAGER_COMMANDS[manager] ?? PACKAGE_MANAGER_COMMANDS[DEFAULT_PACKAGE_MANAGER]!;
  const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
  if ("vitest" in dependencies) {
    return [{ Kind: "vitest", Dir: dir, Command: `${commands.exec} vitest run`, Detail: "" }];
  }
  if ("jest" in dependencies) return [{ Kind: "jest", Dir: dir, Command: `${commands.exec} jest`, Detail: "" }];
  const script = parsed.scripts?.test;
  return script === undefined ? [] : [{ Kind: "npm", Dir: dir, Command: `${commands.script} test --`, Detail: script }];
}

async function goRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  const mod = await machine.readTextFile(at(home, dir, "go.mod"));
  if (mod === undefined) return [];
  return [{ Kind: "go", Dir: dir, Command: "go test", Detail: GO_MODULE.exec(mod)?.[1] ?? "" }];
}

async function pythonRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  const configured = await machine.isFile(at(home, dir, "pytest.ini"))
    || (await Promise.all(PYTHON_CONFIG_FILES.map((name) => machine.readTextFile(at(home, dir, name)))))
      .some((text) => text !== undefined && PYTEST_CONFIGURED.test(text));
  return configured ? [{ Kind: "pytest", Dir: dir, Command: "pytest", Detail: "" }] : [];
}

async function cargoRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  return await machine.isFile(at(home, dir, "Cargo.toml"))
    ? [{ Kind: "cargo", Dir: dir, Command: "cargo test", Detail: "" }]
    : [];
}

async function phpRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  const configs = await Promise.all(PHPUNIT_CONFIG_FILES.map((name) => machine.isFile(at(home, dir, name))));
  return configs.some(Boolean) ? [{ Kind: "phpunit", Dir: dir, Command: "vendor/bin/phpunit", Detail: "" }] : [];
}

async function makeRunner(home: string, dir: string, machine: Machine): Promise<Runner[]> {
  const text = await machine.readTextFile(at(home, dir, "Makefile"));
  const targets = [...(text ?? "").matchAll(MAKE_TEST_TARGET)].map((match) => match[1]!);
  return targets.length === 0
    ? []
    : [{ Kind: "make", Dir: dir, Command: "make", Detail: `targets: ${[...new Set(targets)].join(", ")}` }];
}

/** `path`'s directories, the nearest first: "a/b/c.go" gives "a/b", "a". */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, depth) => parts.slice(0, parts.length - depth).join("/"));
}

/**
 * The directories to look in: the project root; each directory above the test files nearest the goal (a Go module or a
 * vitest config often sits beside them, below the root); then the top-level directories that hold test files.
 */
function candidateDirectories(testFiles: readonly string[], nearFiles: readonly string[]): string[] {
  const tops = testFiles.filter((file) => file.includes("/")).map((file) => file.slice(0, file.indexOf("/")));
  const wanted = ["", ...nearFiles.flatMap(ancestorsOf), ...tops.filter((top) => !TEST_DIRECTORIES.has(top))];
  return [...new Set(wanted)].filter((dir) => !isTestDirectory(dir)).slice(0, RUNNER_DIRECTORY_LIMIT + 1);
}

const isTestDirectory = (dir: string): boolean => TEST_DIRECTORIES.has(dir.split("/").pop() ?? "");

/**
 * How the checkout runs its tests, read from its root config files and the same files in the directories
 * `candidateDirectories` picks: go.mod, package.json (vitest, jest or a `test` script, with the package manager it
 * names), pytest config, Cargo.toml, phpunit config and Makefile test targets. One read per file; nothing is listed.
 */
export async function detectRunners(
  home: string,
  testFiles: readonly string[],
  nearFiles: readonly string[],
  machine: Machine,
): Promise<Runner[]> {
  const found = await Promise.all(
    candidateDirectories(testFiles, nearFiles).map(async (dir) =>
      (await Promise.all([
        goRunner(home, dir, machine),
        javascriptRunner(home, dir, machine),
        pythonRunner(home, dir, machine),
        cargoRunner(home, dir, machine),
        phpRunner(home, dir, machine),
        makeRunner(home, dir, machine),
      ])).flat()
    ),
  );
  return found.flat();
}
