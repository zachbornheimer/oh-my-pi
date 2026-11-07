import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SITES_DIRECTORY_ENVIRONMENT, siteContextFrom, type SiteContext, sitesDirectory } from "./site_context.ts";

/** What a finished process left behind. `code` is -1 when the process could not start or was stopped. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a process and never throws for a non-zero exit; a cancelled run throws. */
export type RunProcess = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<ProcessResult>;

/**
 * The machine the tool runs on, as the asset listing and the fact readers see it: files, one process runner and the
 * environment. Tests pass a scripted one.
 */
export interface Machine {
  readonly homeDirectory: string;
  /** Runs `command`; never throws for a non-zero exit. */
  run(command: string, args: readonly string[]): Promise<ProcessResult>;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  /** The names (not paths) inside the directory, sorted; empty when it is missing or unreadable. */
  listDirectory(path: string): Promise<string[]>;
  /** The environment variable's value, or undefined when it is unset. */
  environment(name: string): string | undefined;
}

/** The real machine: node:fs, the given process runner (with `signal` for cancellation) and the process environment. */
export function systemMachine(
  run: RunProcess,
  options: { signal?: AbortSignal; environment?: Readonly<Record<string, string | undefined>>; home?: string } = {},
): Machine {
  const env = options.environment ?? process.env;
  return {
    homeDirectory: options.home ?? homedir(),
    run: (command, args) => run(command, args, options.signal),
    readTextFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    listDirectory: async (path) => {
      try {
        return (await readdir(path)).sort();
      } catch {
        return [];
      }
    },
    environment: (name) => env[name],
  };
}

/** Every site file name, in directory order. */
export async function siteNames(machine: Machine): Promise<string[]> {
  const names: string[] = [];
  for (const file of await machine.listDirectory(sitesDirectory({ [SITES_DIRECTORY_ENVIRONMENT]: machine.environment(SITES_DIRECTORY_ENVIRONMENT) }, machine.homeDirectory))) {
    if (file.endsWith(".yaml")) names.push(file.slice(0, -".yaml".length));
  }
  return names;
}

/** The site a name refers to, read (never written) from the webmaster CLI's site files. */
export async function siteContextNamed(name: string, machine: Machine): Promise<SiteContext> {
  const directory = sitesDirectory({ [SITES_DIRECTORY_ENVIRONMENT]: machine.environment(SITES_DIRECTORY_ENVIRONMENT) }, machine.homeDirectory);
  const path = join(directory, `${name}.yaml`);
  const text = await machine.readTextFile(path);
  if (text === undefined) throw new Error(`site "${name}": no site file at ${path}`);
  return siteContextFrom(text, name, path);
}
