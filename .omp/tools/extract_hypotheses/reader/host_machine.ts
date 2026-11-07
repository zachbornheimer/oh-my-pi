import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/** The files and directories of the machine a transcript reader may look at. Read-only. */
export interface HostMachine {
  readonly homeDirectory: string;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** The names (not paths) inside the directory, sorted; empty when it is missing or unreadable. */
  listDirectory(path: string): Promise<string[]>;
  /** When the file last changed, in epoch milliseconds; undefined when it is missing or unreadable. */
  modifiedAtMs(path: string): Promise<number | undefined>;
  /** The file's lines, one at a time, so a file too big to hold as text can be read; undefined when it cannot be opened. */
  readLines(path: string): Promise<AsyncIterable<string> | undefined>;
}

/** The real machine: the files and directories of the user running omp. `home` is overridable for tests. */
export function osHostMachine(home: string = homedir()): HostMachine {
  return {
    homeDirectory: home,
    readTextFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
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
  };
}
