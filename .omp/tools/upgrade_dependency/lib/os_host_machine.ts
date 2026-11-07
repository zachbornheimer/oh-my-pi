import { type ExecFileException, type ExecFileOptionsWithStringEncoding, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { HostMachine, ProcessResult } from "./host_machine.js";
import { type AllowedProgram, isAllowedProgram } from "./allowed_programs.js";

const COULD_NOT_START = -1;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Longest one child process may run before it is killed. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

function resultOf(error: unknown, stdout: string, stderr: string): ProcessResult {
  const failure = error as { code?: unknown; message: string } | null;
  if (failure === null) return { code: 0, stdout, stderr };
  if (typeof failure.code === "number") return { code: failure.code, stdout, stderr };
  return { code: COULD_NOT_START, stdout, stderr: stderr || failure.message };
}

type ExecOptions = ExecFileOptionsWithStringEncoding;
type ExecDone = (error: ExecFileException | null, stdout: string, stderr: string) => void;

/** Starts one allowlisted program with no shell; the literal at each call is what keeps the executable a closed set. */
function execAllowedProgram(program: AllowedProgram, args: string[], options: ExecOptions, done: ExecDone): void {
  switch (program) {
    case "git":
      execFile("git", args, options, done);
      return;
    case "gh":
      execFile("gh", args, options, done);
      return;
    case "omp":
      execFile("omp", args, options, done);
      return;
    case "aube":
      execFile("aube", args, options, done);
      return;
    case "pnpm":
      execFile("pnpm", args, options, done);
      return;
    case "npm":
      execFile("npm", args, options, done);
      return;
    case "go":
      execFile("go", args, options, done);
      return;
    case "mise":
      execFile("mise", args, options, done);
      return;
    case "which":
      execFile("which", args, options, done);
      return;
    case "rg":
      execFile("rg", args, options, done);
      return;
    case "node":
      execFile("node", args, options, done);
      return;
  }
}

/** The real machine: child processes, files and directories of the user running the tool, rooted at `workingDirectory`. */
export function osHostMachine(
  workingDirectory: string = process.cwd(),
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): HostMachine {
  const run: HostMachine["run"] = (command, args, env = {}) => {
    const { promise, resolve } = Promise.withResolvers<ProcessResult>();
    const finish = (error: ExecFileException | null, stdout: string, stderr: string): void =>
      resolve(resultOf(error, stdout, stderr));
    const execOptions = {
      cwd: workingDirectory,
      env: { ...process.env, ...env },
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      signal: options.signal,
      encoding: "utf8" as const,
      shell: false,
    };
    if (isAllowedProgram(command)) execAllowedProgram(command, [...args], execOptions, finish);
    else resolve({ code: COULD_NOT_START, stdout: "", stderr: `"${command}" is not a program this tool may run` });
    return promise;
  };
  const environment: HostMachine["environment"] = (name) => process.env[name];
  return {
    workingDirectory,
    homeDirectory: homedir(),
    run,
    readTextFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeTextFile: async (path, text) => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      } catch (error) {
        throw new Error(`cannot write ${path}: ${(error as Error).message}`);
      }
    },
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    listDirectory: async (path) => {
      try {
        return (await readdir(path)).sort();
      } catch {
        return [];
      }
    },
    modifiedAtMs: async (path) => {
      try {
        return Math.trunc((await stat(path)).mtimeMs);
      } catch {
        return undefined;
      }
    },
    readLines: async (path) => {
      try {
        if (!(await stat(path)).isFile()) return undefined;
      } catch {
        return undefined;
      }
      return createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    },
    environment,
  };
}
