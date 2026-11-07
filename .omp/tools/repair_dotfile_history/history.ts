/**
 * The pure core of `repair_dotfile_history`: live to store path mapping, the plaintext-blob scan, the origin-reachable
 * refusal, and the argument-list builders. Git facts arrive through the injected `GitRunner`, so the playbook's decision
 * logic is tested against a real git in a temp directory without touching the real history store.
 */

/** Mise marks an encrypted blob with this prefix; any blob without it is plaintext. */
export const ENCRYPTED_PREFIX = "mise-encrypted-file-v1";

/** The store ref whose commits are published; plaintext reachable from it cannot be rewritten without a force-push. */
export const PUBLISHED_REF = "origin/setup";

/** The branch the history store rewrites: the local-only line. */
export const LOCAL_BRANCH = "main";

/** The flag that lets mise publish older plaintext. This tool never passes it, and no command it builds may contain it. */
export const PLAINTEXT_ESCAPE_FLAG = "--allow-plaintext-history";

/** One git invocation: args as `git` receives them (after `-C <dir>`), run in `repoDir`; the raw stdout. Failures throw. */
export type GitRunner = (args: readonly string[], repoDir: string) => Promise<string>;

/** One path's plaintext exposure: which commits hold an unencrypted blob for it, reachable from one ref. */
export interface PathOffenses {
  readonly storePath: string;
  readonly commits: readonly string[];
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Characters that are glob or escape syntax in a git pathspec. A path is one file, never a pattern. */
const PATHSPEC_SYNTAX = /[*?[\]\\]/;

/**
 * Maps a live dotfile path to the store-relative path: strip a leading `~/` (or an absolute path under `home`) and prefix
 * `home/`. A path already store-relative (`home/...`) is kept. Refused: empty, outside the home tree, `~` alone, a `.` or
 * `..` or empty segment, a trailing slash, a quote, a control character, or glob syntax. The result is interpolated into
 * a single-quoted git index filter and used as a git pathspec, so it must name exactly one file.
 */
export function storePathFor(livePath: string, home: string): string {
  const trimmed = livePath.trim();
  if (trimmed === "") throw new Error("empty path");
  let relative: string;
  if (trimmed.startsWith("home/")) relative = trimmed.slice("home/".length);
  else if (trimmed.startsWith("~/")) relative = trimmed.slice(2);
  else if (trimmed === "~") throw new Error("`~` alone is not a file path");
  else if (trimmed.startsWith(`${home}/`)) relative = trimmed.slice(home.length + 1);
  else throw new Error(`path is not under the home tree: ${trimmed}`);
  if (relative === "") throw new Error(`path names no file: ${trimmed}`);
  if (relative.includes("'") || relative.includes('"') || CONTROL_CHARACTERS.test(relative) || PATHSPEC_SYNTAX.test(relative)) {
    throw new Error(`path cannot be used as a single literal git path: ${JSON.stringify(trimmed)}`);
  }
  if (relative.endsWith("/") || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`path must be a plain file path with no empty, . or .. segment: ${trimmed}`);
  }
  return `home/${relative}`;
}

/** The live file a store path was saved from, as an absolute path under `home`. */
export function livePathFor(storePath: string, home: string): string {
  if (!storePath.startsWith("home/")) throw new Error(`not a store path: ${storePath}`);
  return `${home}/${storePath.slice("home/".length)}`;
}

/** Whether one blob's content marks it encrypted: the prefix must lead the file. */
export function blobIsEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTED_PREFIX);
}

/** The blob of `storePath` in `commit`, when the path is there; undefined when absent. A directory at the path throws. */
export async function blobAt(git: GitRunner, repoDir: string, commit: string, storePath: string): Promise<string | undefined> {
  const entry = (await git(["ls-tree", commit, "--", storePath], repoDir)).split("\n")[0] ?? "";
  if (entry.trim() === "") return undefined;
  const [meta = ""] = entry.split("\t");
  const [, type, sha] = meta.trim().split(/\s+/);
  if (type !== "blob" || sha === undefined) {
    throw new Error(`${storePath} is not a file in ${commit.slice(0, 12)} (a ${type ?? "unknown"}); name files, not directories`);
  }
  return sha;
}

/**
 * For each path, the commits reachable from `ref` that hold a blob for it without the encrypted prefix. A commit where the
 * path is absent contributes nothing (a removed path is not an offender); a commit where the blob lacks the prefix is.
 */
export async function plaintextCommits(
  git: GitRunner,
  repoDir: string,
  ref: string,
  storePaths: readonly string[],
): Promise<readonly PathOffenses[]> {
  const offenses: PathOffenses[] = [];
  for (const storePath of storePaths) {
    const commits = (await git(["rev-list", ref, "--", storePath], repoDir)).split("\n").filter((line) => line !== "");
    const plaintext: string[] = [];
    for (const commit of commits) {
      const blobSha = await blobAt(git, repoDir, commit, storePath);
      if (blobSha === undefined) continue;
      if (!blobIsEncrypted(await git(["cat-file", "blob", blobSha], repoDir))) plaintext.push(commit);
    }
    offenses.push({ storePath, commits: plaintext });
  }
  return offenses;
}

/**
 * The refusal guard: plaintext for a path reachable from `origin/setup` would need a force-push to unpublish, which is out
 * of scope. Throws with the offending commits so the repair never starts.
 */
export async function refuseIfPublished(git: GitRunner, repoDir: string, storePaths: readonly string[]): Promise<void> {
  const published = await plaintextCommits(git, repoDir, PUBLISHED_REF, storePaths);
  const offenders = published.filter((offense) => offense.commits.length > 0);
  if (offenders.length === 0) return;
  const detail = offenders.map((offense) => `${offense.storePath}: ${offense.commits.join(", ")}`).join("; ");
  throw new Error(`refusing repair: plaintext blobs reachable from ${PUBLISHED_REF} would require a force-push (${detail})`);
}

/** Wraps one argument in single quotes for the index filter, which git hands to `sh -c`. Paths never contain a quote. */
const singleQuoted = (argument: string): string => `'${argument.replaceAll("'", "'\\''")}'`;

/** `git --literal-pathspecs -C <dir> <args...>`: the argument list for one git call. */
export function gitArgs(repoDir: string, args: readonly string[]): string[] {
  return ["--literal-pathspecs", "-C", repoDir, ...args];
}

/** The command that drops every path from `main` in the copy: `env ... git filter-branch --index-filter 'git rm --cached ...'`. */
export function filterBranchCommand(storeDir: string, storePaths: readonly string[]): { command: string; args: string[] } {
  const quoted = storePaths.map(singleQuoted).join(" ");
  return {
    command: "env",
    args: [
      "FILTER_BRANCH_SQUELCH_WARNING=1",
      "GIT_LITERAL_PATHSPECS=1",
      "git",
      "-C",
      storeDir,
      "filter-branch",
      "-f",
      "--index-filter",
      `git rm --cached --ignore-unmatch -- ${quoted}`,
      "--",
      LOCAL_BRANCH,
    ],
  };
}

/** Whether a command's argument list passes the plaintext escape hatch. Checked before every process this tool starts. */
export function allowsPlaintextHistory(command: string, args: readonly string[]): boolean {
  return [command, ...args].some((word) => word.includes(PLAINTEXT_ESCAPE_FLAG));
}
