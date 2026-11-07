import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "./omp_session.js";

/** A commit the applier named in its answer that a repository on this machine really holds. */
export interface Commit {
  repo: string;
  sha: string;
}

/** A git sha as prose carries it: 7 to 40 hex characters with at least one letter and one digit (a bare number is a count, not a sha). */
export const SHA = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g;
/** An absolute path on this machine as prose carries it, `~` included. */
export const PATH = /(?:~|\/Users)\/[^\s`'"()[\]<>,;]+/g;

const expanded = (path: string, home: string): string => (path.startsWith("~/") ? join(home, path.slice(2)) : path);

/** Runs a command; a spawn failure or a non-zero exit is `undefined`, never an exception. */
async function stdoutOf(
  exec: Exec,
  command: "chezmoi" | "git",
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = command === "git" ? await exec("git", args, { signal }) : await exec("chezmoi", args, { signal });
    return result.code === 0 && !result.killed ? result.stdout : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/** The repositories an answer could mean: every path it names (its directory when it is a file), then the chezmoi source. */
export async function repositoriesNamed(
  answer: string,
  exec: Exec,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<string[]> {
  const home = options.home ?? homedir();
  const candidates = new Set<string>();
  for (const named of answer.match(PATH) ?? []) {
    const path = expanded(named.replace(/[.:]+$/, ""), home);
    const isDirectory = await stat(path).then((s) => s.isDirectory()).catch(() => false);
    candidates.add(isDirectory ? path : dirname(path));
  }
  const source = await stdoutOf(exec, "chezmoi", ["source-path"], options.signal);
  if (source !== undefined && source.trim() !== "") candidates.add(source.trim());
  return [...candidates];
}

/** The git toplevel of the first repository holding `sha`, or none: a sha nothing holds is a claim, not a commit. */
export async function repoHolding(
  sha: string,
  repositories: readonly string[],
  exec: Exec,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const candidate of repositories) {
    if ((await stdoutOf(exec, "git", ["-C", candidate, "cat-file", "-e", `${sha}^{commit}`], signal)) === undefined) continue;
    const top = await stdoutOf(exec, "git", ["-C", candidate, "rev-parse", "--show-toplevel"], signal);
    if (top !== undefined && top.trim() !== "") return top.trim();
  }
  return undefined;
}

/** Every sha the answer names, sorted into the commits that exist (with the repository that holds each) and the rest. */
export async function commitsNamed(
  answer: string,
  exec: Exec,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<{ commits: Commit[]; unverified: string[] }> {
  const repositories = await repositoriesNamed(answer, exec, options);
  const commits: Commit[] = [];
  const unverified: string[] = [];
  for (const sha of new Set(answer.match(SHA) ?? [])) {
    const repo = await repoHolding(sha, repositories, exec, options.signal);
    if (repo === undefined) unverified.push(sha);
    else commits.push({ repo, sha });
  }
  return { commits, unverified };
}
