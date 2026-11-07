import type { Machine } from "./machine.js";

/** Directories that hold dependencies, build output, history or other checkouts, never the folder's own work. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
  "worktrees",
]);
/** Hidden entries are skipped (they hold secrets and tool state), except the one that holds CI workflows. */
const KEPT_HIDDEN: ReadonlySet<string> = new Set([".github"]);
export const MAX_WALKED_FILES = 2500;

export interface FolderWalk {
  /** Paths below the root, `/`-separated, shallow first, each directory's entries sorted. */
  readonly files: string[];
  /** True when the walk stopped at `MAX_WALKED_FILES`. */
  readonly truncated: boolean;
}

function walked(name: string): boolean {
  if (name.startsWith(".")) return KEPT_HIDDEN.has(name);
  return !SKIPPED_DIRECTORIES.has(name);
}

/** The files below `root`, breadth first, without dependencies, build output, hidden entries or other checkouts. */
export async function walkFolder(root: string, machine: Machine, signal?: AbortSignal): Promise<FolderWalk> {
  const files: string[] = [];
  let level = [""];
  while (level.length > 0) {
    const next: string[] = [];
    for (const directory of level) {
      signal?.throwIfAborted();
      const base = directory === "" ? root : `${root}/${directory}`;
      for (const entry of (await machine.listDirectory(base)).filter((each) => walked(each.name))) {
        const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
        if (entry.directory) next.push(path);
        else files.push(path);
      }
      if (files.length >= MAX_WALKED_FILES) return { files: files.slice(0, MAX_WALKED_FILES), truncated: true };
    }
    level = next;
  }
  return { files, truncated: false };
}
