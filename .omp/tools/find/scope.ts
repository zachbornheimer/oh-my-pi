import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * The search-scope guard for a tool that walks a directory tree. A tool call cannot be wrapped in `timeout`, so a
 * home or system root and a known-huge tree are both refused outright and the caller is told to name a narrower
 * directory. Incident (2026-09): searches rooted at `/Users/...` ran 35-95 minutes each and pushed the machine's
 * load average past 600.
 */

export type ScopeVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Rooted here, a search walks the whole home or system tree: always refused. `~` stands for the home directory. */
export const DENIED_ROOTS: readonly string[] = ["~", "/", "/Users", "/System", "/Volumes", "/private", "/opt", "/usr"];

/** Known-huge trees one level below home: refused for a tool call, which cannot run under a timeout. */
export const HUGE_TREE_ROOTS: readonly string[] = [
  "~/Developer",
  "~/Dropbox",
  "~/Library",
  "~/Documents",
  "~/Downloads",
  "~/.cache",
  "~/go",
];

/** Trees whose direct children (`~/Developer/<Org>`) are huge too. */
export const HUGE_TREE_PARENTS: readonly string[] = ["~/Developer"];

const MAX_TIMEOUT_SECONDS = 120;
const HOME_SPELLINGS = ["${HOME}", "$HOME", "~"] as const;

function deniedRootReason(tool: string, root: string): string {
  return `This \`${tool}\` search is rooted at '${root}', which walks the whole home or system tree. `
    + "Name a narrower directory instead — the repo root, `~/Developer/<Org>/<repo>`, or `~/.claude`.";
}

function hugeTreeToolReason(tool: string, root: string): string {
  return `This \`${tool}\` tool call is rooted at '${root}', a known-large tree, and a tool call cannot `
    + "be wrapped in `timeout`. Name a narrower directory (`~/Developer/<Org>/<repo>`), or run "
    + `\`timeout ${MAX_TIMEOUT_SECONDS} fd ...\` / \`rg ...\` through run_command.`;
}

function homeDirectory(home?: string): string {
  const chosen = home ?? process.env.HOME ?? homedir();
  return chosen.length > 1 ? chosen.replace(/\/+$/, "") : chosen;
}

function withHome(root: string, home: string): string {
  if (root === "~") return home;
  return root.startsWith("~/") ? `${home}${root.slice(1)}` : root;
}

function expandHome(word: string, home: string): string {
  for (const spelling of HOME_SPELLINGS) {
    if (word === spelling) return home;
    if (word.startsWith(`${spelling}/`)) return `${home}/${word.slice(spelling.length + 1)}`;
  }
  return word;
}

/** An absolute path with home expanded, `.`/`..` folded and no trailing slash; relative words join `cwd`. */
function normalizeRoot(word: string, cwd: string, home: string): string {
  const expanded = expandHome(word, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

type RootClass = "denied" | "huge" | "ordinary";

function classifyRoot(normalized: string, home: string): RootClass {
  if (DENIED_ROOTS.some((root) => withHome(root, home) === normalized)) return "denied";
  if (HUGE_TREE_ROOTS.some((root) => withHome(root, home) === normalized)) return "huge";
  for (const parent of HUGE_TREE_PARENTS) {
    const prefix = `${withHome(parent, home)}/`;
    if (!normalized.startsWith(prefix)) continue;
    const remainder = normalized.slice(prefix.length);
    if (remainder !== "" && !remainder.includes("/")) return "huge";
  }
  return "ordinary";
}

/** Whether a search tool may walk `path` (`cwd` when empty). */
export function checkSearchRoot(
  path: string,
  cwd: string,
  options: {
    readonly tool?: string;
    readonly home?: string;
    /** A tool named with an explicit directory (a repository) may sit under a known-huge parent; only home and system roots are refused. */
    readonly allowHuge?: boolean;
  } = {},
): ScopeVerdict {
  const tool = options.tool ?? "search";
  const rootWord = path === "" ? cwd : path;
  if (rootWord === "") return { allowed: true };
  const home = homeDirectory(options.home);
  const kind = classifyRoot(normalizeRoot(rootWord, cwd === "" ? process.cwd() : resolve(cwd), home), home);
  if (kind === "denied") return { allowed: false, reason: deniedRootReason(tool, rootWord) };
  if (kind === "huge" && options.allowHuge !== true) {
    return { allowed: false, reason: hugeTreeToolReason(tool, rootWord) };
  }
  return { allowed: true };
}

/** `checkSearchRoot`, thrown as the tool's own error. */
export function assertSearchRoot(
  path: string,
  cwd: string,
  tool: string,
  options: { readonly home?: string; readonly allowHuge?: boolean } = {},
): void {
  const verdict = checkSearchRoot(path, cwd, { tool, ...options });
  if (!verdict.allowed) throw new Error(verdict.reason);
}
