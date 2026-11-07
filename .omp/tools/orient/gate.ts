import { dirname, relative } from "node:path";
import type { Gate } from "./schemas.js";

/**
 * The command that runs one test, derived from the manifest nearest the test file: Cargo, a Node package
 * (vitest, jest, bun), Go, or Python. Deterministic: the test file's extension picks the ecosystem, the nearest
 * manifest of that ecosystem (at or above the file, not above the repository) picks the directory, and the
 * manifest's own text picks the runner. It never runs anything.
 */

export interface GateMachine {
  isFile(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string | undefined>;
}

export type GateResult = { readonly gate: Gate; readonly gap: "" } | { readonly gate: null; readonly gap: string };

const ECOSYSTEMS: ReadonlyArray<{ readonly extensions: RegExp; readonly manifests: readonly string[] }> = [
  { extensions: /\.rs$/, manifests: ["Cargo.toml"] },
  { extensions: /\.[cm]?[jt]sx?$/, manifests: ["package.json"] },
  { extensions: /\.go$/, manifests: ["go.mod"] },
  { extensions: /\.py$/, manifests: ["pyproject.toml", "pytest.ini", "setup.cfg", "setup.py"] },
];

/** A shell word: single-quoted, so a test title with spaces or `$` survives. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** A test title as a literal pattern for runners whose `-t` is a regular expression. */
function literalPattern(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function nearestManifest(
  machine: GateMachine,
  repo: string,
  file: string,
  manifests: readonly string[],
): Promise<{ directory: string; manifest: string } | undefined> {
  let directory = dirname(file);
  for (;;) {
    for (const manifest of manifests) {
      if (await machine.isFile(`${directory}/${manifest}`)) return { directory, manifest };
    }
    if (directory === repo || !directory.startsWith(`${repo}/`)) return undefined;
    directory = dirname(directory);
  }
}

function rustCommand(rel: string, name: string | null): { command: string; detail: string } {
  const target = /^tests\/([^/]+)\.rs$/.exec(rel)?.[1];
  const filter = name === null ? "" : ` ${shellWord(name)}`;
  return target === undefined
    ? { command: `cargo test${filter}`, detail: "unit test in the crate" }
    : { command: `cargo test --test ${shellWord(target)}${filter}`, detail: `integration test target ${target}` };
}

async function nodeCommand(
  machine: GateMachine,
  directory: string,
  rel: string,
  name: string | null,
): Promise<{ command: string; detail: string }> {
  const manifest = (await machine.readTextFile(`${directory}/package.json`)) ?? "";
  const title = name === null ? "" : ` -t ${shellWord(literalPattern(name))}`;
  if (/"vitest"/.test(manifest)) return { command: `bunx vitest run ${shellWord(rel)}${title}`, detail: "vitest via bunx" };
  if (/"jest"/.test(manifest)) return { command: `bunx jest ${shellWord(rel)}${title}`, detail: "jest via bunx" };
  if (await machine.isFile(`${directory}/bun.lock`) || await machine.isFile(`${directory}/bun.lockb`)) {
    return { command: `bun test ${shellWord(rel)}${title}`, detail: "bun test" };
  }
  return { command: `bun run test -- ${shellWord(rel)}`, detail: "the package's test script" };
}

async function pythonCommand(
  machine: GateMachine,
  directory: string,
  rel: string,
  name: string | null,
): Promise<{ command: string; detail: string }> {
  const runner = await machine.isFile(`${directory}/uv.lock`) ? "uv run pytest" : "python -m pytest";
  const filter = name === null ? "" : ` -k ${shellWord(name)}`;
  return { command: `${runner} ${shellWord(rel)}${filter}`, detail: runner };
}

/** The command that runs `name` (or the whole file when null) in `file`, or why there is none. */
export async function gateFor(
  machine: GateMachine,
  repo: string,
  file: string,
  name: string | null,
): Promise<GateResult> {
  const ecosystem = ECOSYSTEMS.find((entry) => entry.extensions.test(file));
  if (ecosystem === undefined) return { gate: null, gap: `no test runner is known for ${file}` };
  const found = await nearestManifest(machine, repo, file, ecosystem.manifests);
  if (found === undefined) {
    return { gate: null, gap: `no ${ecosystem.manifests.join(" or ")} at or above ${file} inside ${repo}` };
  }
  const rel = relative(found.directory, file);
  let derived: { command: string; detail: string };
  if (found.manifest === "Cargo.toml") {
    derived = rustCommand(rel, name);
  } else if (found.manifest === "package.json") {
    derived = await nodeCommand(machine, found.directory, rel, name);
  } else if (found.manifest === "go.mod") {
    const directory = dirname(rel);
    const run = name === null ? "" : ` -run ${shellWord(`^${name}$`)}`;
    derived = { command: `go test ${directory === "." ? "." : `./${directory}`}${run}`, detail: "go test" };
  } else {
    derived = await pythonCommand(machine, found.directory, rel, name);
  }
  return {
    gate: {
      command: derived.command,
      cwd: found.directory,
      basis: `${found.manifest} at ${found.directory}; ${derived.detail}`,
    },
    gap: "",
  };
}
