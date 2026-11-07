import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec } from "./omp_model.js";

/** Longest a summarized command may run before it is killed. */
export const COMMAND_TIMEOUT_MS = 300_000;

export interface RawOutput {
  path: string;
  lines: number;
}

/** What the model reads and what the caller gets back: the source text, its label, and where the full raw output lives. */
export interface Prepared {
  argument: string;
  text: string;
  raw_output: RawOutput;
}

export interface GatherDeps {
  exec: Exec;
  cwd: string;
  home?: string;
  /** Directory the command output is written to; defaults to the OS temp directory. */
  tempDir?: string;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
}

/** Lines in `text`, counting a final line that has no newline. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

function pathOf(file: string, deps: GatherDeps): string {
  const trimmed = file.trim();
  if (trimmed.startsWith("~/")) return resolve(deps.home ?? homedir(), trimmed.slice(2));
  return resolve(deps.cwd, trimmed);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Reads `file` as the raw output itself. A missing path is an error, not a command. */
export async function readSource(file: string, deps: GatherDeps): Promise<Prepared> {
  const trimmed = file.trim();
  const existing = pathOf(trimmed, deps);
  if (!(await isFile(existing))) throw new Error(`summarize: not a file: ${existing}`);
  let text: string;
  try {
    text = await readFile(existing, "utf8");
  } catch (error) {
    throw new Error(`summarize: cannot read ${existing}: ${(error as Error).message}`);
  }
  return { argument: trimmed, text, raw_output: { path: existing, lines: lineCount(text) } };
}

/** Runs `command` under `sh -c` in the session directory and writes stdout then stderr to a new private temp file. */
export async function runSource(command: string, deps: GatherDeps): Promise<Prepared> {
  const trimmed = command.trim();
  if (trimmed === "") throw new Error("summarize: command is required");
  const timeout = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const ran = await deps.exec("sh", ["-c", trimmed], { cwd: deps.cwd, signal: deps.signal, timeout });
  if (ran.killed) {
    deps.signal?.throwIfAborted();
    throw new Error(`summarize: the command was killed after ${timeout / 1000} s: ${trimmed}`);
  }
  if (ran.code === 127) throw new Error(ran.stderr || `summarize: could not run ${trimmed}`);
  const text = ran.stderr === "" ? ran.stdout : `${ran.stdout}${ran.stdout.endsWith("\n") || ran.stdout === "" ? "" : "\n"}${ran.stderr}`;
  const path = join(deps.tempDir ?? tmpdir(), `${randomUUID()}.txt`);
  try {
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    throw new Error(`summarize: cannot write ${path}: ${(error as Error).message}`);
  }
  return { argument: trimmed, text, raw_output: { path, lines: lineCount(text) } };
}

/** `{file}`, `{command}` or `{argument}` made into source text; an argument that names an existing file is read, anything else is run. */
export async function prepare(input: { file?: string | null; command?: string | null; argument?: string | null }, deps: GatherDeps): Promise<Prepared> {
  const file = input.file?.trim() ? input.file : undefined;
  const command = input.command?.trim() ? input.command : undefined;
  const argument = input.argument?.trim() ? input.argument : undefined;
  if (file !== undefined && command !== undefined) throw new Error("summarize: pass file or command, not both");
  if (file !== undefined) return readSource(file, deps);
  if (command !== undefined) return runSource(command, deps);
  if (argument !== undefined) {
    return (await isFile(pathOf(argument, deps))) ? readSource(argument, deps) : runSource(argument, deps);
  }
  throw new Error("summarize: pass file, command or argument");
}
