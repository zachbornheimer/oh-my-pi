import type { HostMachine } from "../machine.js";
import { MAX_KNOWN_FILES } from "./limits.js";

const GIT_FILE_LIST = ["ls-files", "--cached", "--others", "--exclude-standard"] as const;

export interface RepoFiles {
  readonly paths: string[];
  readonly truncated: boolean;
}

/** Every file of the repo that git tracks or would track, repo-relative, in git's order. */
export async function listRepoFiles(machine: HostMachine, repo: string): Promise<RepoFiles> {
  const listed = await machine.run("git", ["-C", repo, ...GIT_FILE_LIST]);
  if (listed.code !== 0) {
    throw new Error(
      `implement_code: \`git -C ${repo} ls-files\` failed (exit ${listed.code}): ${listed.stderr.trim()}; the repo must be a git checkout`,
    );
  }
  const all = listed.stdout.split("\n").filter((line) => line !== "");
  return { paths: all.slice(0, MAX_KNOWN_FILES), truncated: all.length > MAX_KNOWN_FILES };
}

/** The repo's top-level directory for `directory` (any directory of it). */
export async function repoRootOf(machine: HostMachine, directory: string): Promise<string> {
  const root = await machine.run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
  if (root.code !== 0) {
    throw new Error(`implement_code: ${directory} is not inside a git repo (exit ${root.code}): ${root.stderr.trim()}`);
  }
  return root.stdout.trim();
}
