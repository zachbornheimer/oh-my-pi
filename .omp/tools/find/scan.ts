import { scoreText } from "./keywords.js";
import { passagesOf } from "./passages.js";
import type { Candidate } from "./schemas.js";

/**
 * The scan half of `find`: list repository files, score them lexically, and return the best
 * candidates with the passages worth judging. Candidate paths are absolute (the scanned working
 * directory joined to the repository-relative name), so a hit goes straight to `read`. It never
 * writes and never calls a model.
 */

/** The most files a scan lists; `truncated` is true when more existed. */
export const MAX_LISTED_FILES = 20_000;
const MAX_FILES = MAX_LISTED_FILES;
const MAX_CANDIDATES = 20;
const MAX_FILE_CHARACTERS = 512 * 1024;
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

export interface ScanResult {
  readonly candidates: Candidate[];
  readonly filesScanned: number;
  /** The most files this scan lists; `truncated` is true when more existed. */
  readonly fileCap: number;
  readonly truncated: boolean;
}

function eligible(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => SKIPPED_DIRECTORIES[segment] === true)) return false;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && !SKIPPED_EXTENSIONS[extension];
}

/** `git ls-files` when this is a repository; a bounded walk otherwise. Shared with `orient`'s test discovery. */
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
      if ((await machine.isDirectory(`${machine.workingDirectory}/${path}`))) {
        if (SKIPPED_DIRECTORIES[name] !== true) queue.push(path);
      } else if (eligible(path)) {
        files.push(path);
      }
    }
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/** The best files for `query`, each with up to two passages; bounded so a large repo stays fast. */
export async function scanForCandidates(
  machine: ScanMachine,
  query: string,
  keywords: readonly string[],
): Promise<ScanResult> {
  const terms = keywords.length === 0 ? [query.toLowerCase()] : keywords;
  const listing = await listFiles(machine);
  const scored: { path: string; score: number; text: string }[] = [];
  for (const path of listing.files) {
    const text = await machine.readTextFile(`${machine.workingDirectory}/${path}`);
    if (text === undefined || text.length > MAX_FILE_CHARACTERS || text.includes("\u0000")) continue;
    const score = scoreText(text, terms) + (terms.some((term) => path.toLowerCase().includes(term)) ? 1 : 0);
    if (score > 0) scored.push({ path, score, text });
  }
  const candidates = scored
    .sort((one, other) => other.score - one.score || one.path.localeCompare(other.path))
    .slice(0, MAX_CANDIDATES)
    .map((entry) => ({
      path: `${machine.workingDirectory}/${entry.path}`,
      score: entry.score,
      passages: passagesOf(entry.text, terms),
    }));
  return { candidates, filesScanned: listing.files.length, fileCap: MAX_FILES, truncated: listing.truncated };
}
