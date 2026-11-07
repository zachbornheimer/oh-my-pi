import type { Conventions } from "./conventions.js";
import type { PlannedFile } from "./locate_checks.js";
import { ancestorsOf, basenameOf, dirnameOf } from "./paths.js";
import type { CheckCommand } from "./schemas.js";

interface PackageRunner {
  readonly run: string;
  readonly exec: string;
}

const RUNNERS: Readonly<Record<string, PackageRunner>> = {
  "aube-lock.yaml": { run: "aube run", exec: "aube exec" },
  "pnpm-lock.yaml": { run: "pnpm run", exec: "pnpm exec" },
  "yarn.lock": { run: "yarn run", exec: "yarn" },
  "bun.lock": { run: "bun run", exec: "bunx" },
  "bun.lockb": { run: "bun run", exec: "bunx" },
  "package-lock.json": { run: "npm run", exec: "npx" },
};
const DEFAULT_RUNNER: PackageRunner = { run: "npm run", exec: "npx" };
const TYPE_SCRIPTS = ["typecheck", "tsc"];
const TEST_RUNNERS = ["vitest run", "jest"] as const;

const inDirectory = (
  directory: string,
  command: string,
): string => (directory === "" ? command : `cd ${directory} && ${command}`);
const relativeTo = (
  directory: string,
  path: string,
): string => (directory === "" ? path : path.slice(directory.length + 1));

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifestOf(text: string): PackageManifest {
  try {
    return JSON.parse(text) as PackageManifest;
  } catch {
    return {};
  }
}

function runnerFor(directory: string, knownFiles: readonly string[]): PackageRunner {
  const known = new Set(knownFiles);
  const levels = directory === "" ? [""] : [directory, ...ancestorsOf(directory)];
  for (const level of levels) {
    for (const [lockfile, runner] of Object.entries(RUNNERS)) {
      if (known.has(level === "" ? lockfile : `${level}/${lockfile}`)) return runner;
    }
  }
  return DEFAULT_RUNNER;
}

function nodeChecks(conventions: Conventions, tests: readonly PlannedFile[], anchor: string): CheckCommand[] {
  const manifest = conventions.registries
    .filter((registry) => basenameOf(registry.path) === "package.json")
    .filter((registry) => ancestorsOf(anchor).includes(dirnameOf(registry.path)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (manifest === undefined) return [];
  const directory = dirnameOf(manifest.path);
  const runner = runnerFor(directory, conventions.layout.known_files);
  const { scripts = {}, dependencies = {}, devDependencies = {} } = manifestOf(manifest.text);
  const installed = { ...dependencies, ...devDependencies };
  const checks: CheckCommand[] = [];
  const typeScript = TYPE_SCRIPTS.find((name) => scripts[name] !== undefined);
  if (typeScript !== undefined) {
    checks.push({ run: inDirectory(directory, `${runner.run} ${typeScript}`), why: "the new code type-checks" });
  }
  const testRunner = TEST_RUNNERS.find((candidate) => installed[candidate.split(" ")[0]!] !== undefined);
  const testPaths = tests.map((test) => relativeTo(directory, test.path)).join(" ");
  if (testRunner !== undefined && testPaths !== "") {
    checks.push({
      run: inDirectory(directory, `${runner.exec} ${testRunner} ${testPaths}`),
      why: "the new tests pass",
    });
  } else if (scripts.test !== undefined) {
    checks.push({ run: inDirectory(directory, `${runner.run} test`), why: "the tests pass" });
  }
  return checks;
}

function goChecks(conventions: Conventions, tests: readonly PlannedFile[], anchor: string): CheckCommand[] {
  const known = new Set(conventions.layout.known_files);
  const root = ancestorsOf(anchor).find((directory) => known.has(directory === "" ? "go.mod" : `${directory}/go.mod`))
    ?? "";
  const packages = [...new Set(tests.map((test) => `./${relativeTo(root, dirnameOf(test.path))}`))];
  if (packages.length === 0) return [];
  return [
    { run: inDirectory(root, `go vet ${packages.join(" ")}`), why: "the new code vets clean" },
    { run: inDirectory(root, `go test ${packages.join(" ")}`), why: "the new tests pass" },
  ];
}

/**
 * The targeted type and test commands to run after the change is applied, from the repo's own manifests; none for a
 * language or layout it does not know. Commands run from the repo root.
 */
export function verificationChecks(conventions: Conventions, plan: readonly PlannedFile[]): CheckCommand[] {
  const tests = plan.filter((file) => file.role === "test");
  const anchor = (tests[0] ?? plan[0])?.path;
  if (anchor === undefined) return [];
  switch (conventions.language) {
    case "typescript":
    case "javascript":
      return nodeChecks(conventions, tests, anchor);
    case "go":
      return goChecks(conventions, tests, anchor);
    case "python":
      return tests.length === 0
        ? []
        : [{ run: `pytest ${tests.map((test) => test.path).join(" ")}`, why: "the new tests pass" }];
    default:
      return [];
  }
}
