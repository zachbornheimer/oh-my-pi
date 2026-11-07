import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OMP_DEFAULT_MODEL } from "./constants.js";
import type { Runner } from "./exec.js";

/** The flags that make `omp -p` a bare completion: no tools, extensions, skills, rules or context files, so it cannot touch the machine. */
export const BARE_OMP_FLAGS = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--no-lsp",
  "--no-pty",
] as const;

export type OmpRun = {
  /** The directory omp starts in. A bare completion gets a private temporary one when none is named. */
  cwd?: string;
  prompt: string;
  /** A model or role (`@default`, `provider/model:thinking`); omp's default when absent. */
  model?: string;
  /** True: no tools and nothing loaded, a completion only. False: a full omp session with every installed tool. */
  bare: boolean;
  budgetMs: number;
  signal?: AbortSignal;
  /** What the run is, for an error that names it. */
  label: string;
};

/**
 * One headless `omp -p` run. The prompt goes in through a private temp file (never argv) removed afterwards. Answers the
 * run's stdout; throws when it is stopped by its budget, cancelled, or exits non-zero, naming the run and what it said.
 */
export async function runOmp(run: Runner, input: OmpRun): Promise<string> {
  input.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "software-factory-omp-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, input.prompt, { mode: 0o600 });
    const cwd = input.cwd ?? directory;
    const args = [
      "-p",
      `@${file}`,
      ...(input.bare ? BARE_OMP_FLAGS : ["--cwd", cwd]),
      ...(input.model === undefined ? [] : ["--model", input.model]),
    ];
    const result = await run("omp", args, {
      cwd,
      timeoutMs: input.budgetMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.killed) {
      if (input.signal?.aborted === true) throw new Error(`${input.label} was cancelled`);
      throw new Error(`${input.label} (omp) was stopped after ${Math.round(input.budgetMs / 1000)} s`);
    }
    if (result.code !== 0) {
      throw new Error(`${input.label} (omp) exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim() || "no output").slice(-2_000)}`);
    }
    return result.stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The text of a verdict file a reviewer was asked to write; throws, naming the path, when it did not write one. */
export async function readVerdictFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`the reviewer wrote no verdict file at ${path}`);
    throw error;
  }
}

/** Clears an old verdict so a stale file is never read as this run's, and makes its directory. */
export async function clearVerdictFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
}

export { OMP_DEFAULT_MODEL };
