import { ancestorsOf, basenameOf, dirnameOf } from "../paths.js";

export interface DirectoryInfo {
  readonly path: string;
  /** Files directly in it, repo-relative. */
  readonly files: string[];
  /** Directories directly in it, repo-relative. */
  readonly subdirectories: string[];
}

/** The repo's directories, each with what is directly in it. The root is the directory "". */
export function indexDirectories(paths: readonly string[]): Map<string, DirectoryInfo> {
  const index = new Map<string, DirectoryInfo>([["", { path: "", files: [], subdirectories: [] }]]);
  const infoOf = (directory: string): DirectoryInfo => {
    let info = index.get(directory);
    if (info === undefined) {
      info = { path: directory, files: [], subdirectories: [] };
      index.set(directory, info);
      infoOf(dirnameOf(directory)).subdirectories.push(directory);
    }
    return info;
  };
  for (const path of paths) infoOf(dirnameOf(path)).files.push(path);
  return index;
}

/** The names directly in `directory`, sorted, a directory's with a trailing `/`; at most `limit`. */
export function entriesOf(index: ReadonlyMap<string, DirectoryInfo>, directory: string, limit: number): string[] {
  const info = index.get(directory);
  if (info === undefined) return [];
  const names = [...info.files.map(basenameOf), ...info.subdirectories.map((path) => `${basenameOf(path)}/`)];
  return names.sort().slice(0, limit);
}

/** The directories above `directory` and itself, nearest first, ending with the root. */
export const chainOf = (
  directory: string,
): string[] => (directory === "" ? [""] : [directory, ...ancestorsOf(directory)]);
