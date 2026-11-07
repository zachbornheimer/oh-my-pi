import { readdir, readFile, stat } from "node:fs/promises";
import type { Exec } from "./omp_model.js";
import type { HostMachine } from "./gather.js";

/** Longest `git ls-files` may run. */
const GIT_TIMEOUT_MS = 60_000;

/** The scan's view of this machine: git through `exec` (cancellable), files through `node:fs`. Never writes. */
export function nodeMachine(exec: Exec, cwd: string, signal?: AbortSignal): HostMachine {
  return {
    workingDirectory: cwd,
    async run(command, args) {
      if (command !== "git") throw new Error(`the scan machine only runs git, not: ${command}`);
      try {
        const result = await exec("git", [...args], { cwd, signal, timeout: GIT_TIMEOUT_MS });
        if (result.killed) signal?.throwIfAborted();
        return { code: result.killed ? -1 : result.code, stdout: result.stdout };
      } catch (error) {
        signal?.throwIfAborted();
        return { code: -1, stdout: error instanceof Error ? error.message : String(error) };
      }
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async listDirectory(path) {
      try {
        return (await readdir(path)).sort();
      } catch {
        return [];
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
  };
}
