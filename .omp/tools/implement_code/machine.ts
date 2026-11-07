import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Exec } from "./omp.js";

/** What a finished process left behind. `code` is -1 when the process could not start. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The machine the tool runs on, as the repo reader and the apply step see it. */
export interface HostMachine {
  /** Runs `command`, in `cwd` when given. Never throws for a non-zero exit or a command that cannot start. */
  run(command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<ProcessResult>;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  /** Writes `text` to the file, making the missing directories and replacing what was there. Throws naming the path. */
  writeTextFile(path: string, text: string): Promise<void>;
}

/** The longest a repo-reading command (git ls-files, git grep) or a planned check may run. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;

/** The only programs the repo reader and the apply step ever start. */
type HostCommand = "git" | "sh";

function execHostCommand(exec: Exec, command: string, args: string[], options: Parameters<Exec>[2]): ReturnType<Exec> {
  switch (command as HostCommand) {
    case "git":
      return exec("git", args, options);
    case "sh":
      return exec("sh", args, options);
    default:
      throw new Error(`host command not allowed: ${command}`);
  }
}

export function hostMachine(exec: Exec, signal?: AbortSignal): HostMachine {
  return {
    async run(command, args, options = {}) {
      signal?.throwIfAborted();
      try {
        const result = await execHostCommand(exec, command, [...args], { cwd: options.cwd, signal, timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS });
        if (result.killed) {
          signal?.throwIfAborted();
          return { code: -1, stdout: result.stdout, stderr: `${command} was stopped after ${(options.timeoutMs ?? COMMAND_TIMEOUT_MS) / 1000} s\n${result.stderr}` };
        }
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        signal?.throwIfAborted();
        return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async writeTextFile(path, text) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      } catch (error) {
        throw new Error(`write ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
