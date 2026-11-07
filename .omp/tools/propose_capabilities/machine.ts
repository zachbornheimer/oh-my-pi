import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";

/** One entry of a directory. The real filesystem leaves symbolic links out of a listing, so a walk cannot loop or leave the folder. */
export interface DirEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** The filesystem the gatherers read: reading only, nothing is written. Tests give an in-memory one. */
export interface Machine {
  readonly homeDirectory: string;
  /** The directory relative paths are read from (omp's working directory). */
  readonly workingDirectory: string;
  /** The first `MAX_READ_BYTES` of the file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  /** True for a directory, a symbolic link to one included (the root a caller names may be a link). */
  isDirectory(path: string): Promise<boolean>;
  /** The entries of the directory sorted by name; empty when it is missing or unreadable. */
  listDirectory(path: string): Promise<DirEntry[]>;
}

/** A file is read to this many bytes, so one huge file cannot fill memory; every source is cut far below it anyway. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** The real filesystem. */
export function osMachine(workingDirectory: string, home: string = homedir()): Machine {
  return {
    homeDirectory: home,
    workingDirectory,
    readTextFile: async (path) => {
      try {
        const file = await open(path, "r");
        try {
          if (!(await file.stat()).isFile()) return undefined;
          const buffer = Buffer.alloc(MAX_READ_BYTES);
          const { bytesRead } = await file.read(buffer, 0, MAX_READ_BYTES, 0);
          return buffer.toString("utf8", 0, bytesRead);
        } finally {
          await file.close();
        }
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
    listDirectory: async (path) => {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries
          .filter((entry) => !entry.isSymbolicLink())
          .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        return [];
      }
    },
  };
}
