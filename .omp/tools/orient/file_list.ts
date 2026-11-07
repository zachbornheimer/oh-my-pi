/**
 * The repository's file listing: `git ls-files` when the directory is a repository, a bounded walk otherwise, with
 * dependency directories, build output and binary extensions dropped. It never writes and never calls a model.
 */

/** The most files a listing keeps; `truncated` is true when more existed. */
export const MAX_LISTED_FILES = 20_000;
const MAX_FILES = MAX_LISTED_FILES;
const SKIPPED_DIRECTORIES: Readonly<Record<string, true>> = {
  node_modules: true,
  ".git": true,
  dist: true,
  build: true,
  ".next": true,
  vendor: true,
  coverage: true,
  ".turbo": true,
};
const SKIPPED_EXTENSIONS: Readonly<Record<string, true>> = {
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
  ico: true,
  pdf: true,
  zip: true,
  gz: true,
  tar: true,
  mp4: true,
  mov: true,
  woff: true,
  woff2: true,
  ttf: true,
  eot: true,
  so: true,
  dylib: true,
  class: true,
  jar: true,
  lockb: true,
};

export interface ScanMachine {
  readonly workingDirectory: string;
  run(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }>;
  readTextFile(path: string): Promise<string | undefined>;
  listDirectory(path: string): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
}

function eligible(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => SKIPPED_DIRECTORIES[segment] === true)) return false;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && !SKIPPED_EXTENSIONS[extension];
}

/** `git ls-files` when this is a repository; a bounded walk otherwise. Shared with test discovery. */
export async function listFiles(machine: ScanMachine): Promise<{ files: string[]; truncated: boolean }> {
  const listed = await machine.run("git", ["ls-files"]);
  if (listed.code === 0) {
    const files = listed.stdout.split("\n").filter((path) => path !== "" && eligible(path));
    return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
  }
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length <= MAX_FILES) {
    const directory = queue.shift()!;
    for (const name of await machine.listDirectory(`${machine.workingDirectory}/${directory}`)) {
      const path = directory === "" ? name : `${directory}/${name}`;
      if (await machine.isDirectory(`${machine.workingDirectory}/${path}`)) {
        if (SKIPPED_DIRECTORIES[name] !== true) queue.push(path);
      } else if (eligible(path)) {
        files.push(path);
      }
    }
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}
