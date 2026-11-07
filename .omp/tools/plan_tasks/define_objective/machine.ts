import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Exec } from "../omp_model.js";

/**
 * Runs `program` (`atask` or `git`, optionally behind an `env KEY=VALUE` prefix) by its literal name through `exec`;
 * any other program is refused.
 */
function execAllowed(exec: Exec, program: string, args: readonly string[], assignments: readonly string[], signal?: AbortSignal) {
  if (assignments.length > 0) {
    if (program !== "atask" && program !== "git") throw new Error(`${program} is not a program this tool runs (atask, git)`);
    return exec("env", [...assignments, program, ...args], { signal });
  }
  switch (program) {
    case "atask":
      return exec("atask", [...args], { signal });
    case "git":
      return exec("git", [...args], { signal });
    default:
      throw new Error(`${program} is not a program this tool runs (atask, git)`);
  }
}

/** What a finished process left behind. `code` is -1 when the process could not start. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The machine the checkout is read from: the small set of reads the gatherers need, so tests can stand in a fake
 * and the real one stays a thin layer over `node:fs` and `pi.exec`.
 */
export interface Machine {
  readonly homeDirectory: string;
  /** Runs `command` with `env` added to the environment. Never throws for a non-zero exit. */
  run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<ProcessResult>;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** The names (not paths) inside the directory, sorted; empty when it is missing or unreadable. */
  listDirectory(path: string): Promise<string[]>;
}

/** The real machine: files through `node:fs`, processes through `pi.exec` (with `env` as an `env KEY=VALUE` prefix). */
export function nodeMachine(exec: Exec, signal?: AbortSignal, home: string = homedir()): Machine {
  return {
    homeDirectory: home,
    async run(command, args, env = {}) {
      const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      try {
        const result = await execAllowed(exec, command, args, assignments, signal);
        return { code: result.killed ? -1 : result.code, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        signal?.throwIfAborted();
        return { code: -1, stdout: "", stderr: (error as Error).message };
      }
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async isDirectory(path) {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async isFile(path) {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    async listDirectory(path) {
      try {
        return (await readdir(path)).sort();
      } catch {
        return [];
      }
    },
  };
}
