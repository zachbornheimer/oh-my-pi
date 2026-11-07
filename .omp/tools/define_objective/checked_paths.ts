import type { ProjectContext } from "./types.js";

const SOURCE_EXTENSIONS = new Set([
  "cue",
  "go",
  "json",
  "md",
  "mod",
  "py",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "js",
  "yaml",
  "yml",
]);
const WORD_SEPARATORS = /[\s"'`()=;|&<>,]+/;
const GLOB_CHARACTER = /[*?[]/;
const NOT_A_PATH = /^-|^~|:|\$|[{}@]|\.\.|^\.+$/;
const COMMAND_SEQUENCE = /&&|\|\||;/;
const MISE_RUN = /\bmise\s+(?:run|r)\s+([^\s;|&)"']+)/g;

const HOST_LABEL = /^[a-z0-9-]+$/i;

/** Two or more dot-separated labels of letters, digits and hyphens: `example.org`, `github.com`. Linear: each label is tested flat. */
export function looksLikeHost(token: string): boolean {
  const labels = token.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label));
}

const extensionOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");

/** The part of `token` before its first glob character, cut back to a whole directory; "" when nothing is left. */
function beforeGlob(token: string): string {
  const at = token.search(GLOB_CHARACTER);
  if (at < 0) return token;
  const cut = token.slice(0, at);
  return cut.slice(0, cut.lastIndexOf("/") + 1);
}

/** `token` as a path below `home` that a layout can answer for, or undefined when it is not one. */
function projectPath(token: string, home: string): string | undefined {
  if (NOT_A_PATH.test(token) && !token.startsWith(`${home}/`)) return undefined;
  const relative = token.startsWith(`${home}/`) ? token.slice(home.length + 1) : token;
  if (relative.startsWith("/")) return undefined;
  const unprefixed = relative.replace(/^(?:\.\/)+/, "");
  const parts = unprefixed.split("/");
  const looksLikeFile = parts.length === 1 && SOURCE_EXTENSIONS.has(extensionOf(unprefixed));
  if (parts.length === 1 && !looksLikeFile) return undefined;
  const path = beforeGlob(unprefixed).replace(/\/+$/, "");
  const kept = path.split("/");
  if (path === "" || kept.some((part) => part.startsWith("."))) return undefined;
  const first = kept[0]!;
  if (looksLikeHost(first) && !SOURCE_EXTENSIONS.has(extensionOf(first))) return undefined;
  return path;
}

const withoutLeadingDot = (path: string): string => path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");

/** The project paths a check names, in the order it names them, below the directory a preceding `cd` moved to. A check's preset prefix ("run:") is not one. */
export function pathsNamedBy(check: string, home: string): string[] {
  const body = check.replace(/^\s*[a-z_]+:/, " ");
  const named: string[] = [];
  let directory = "";
  for (const command of body.split(COMMAND_SEQUENCE)) {
    const tokens = command.split(WORD_SEPARATORS).filter((token) => token !== "");
    for (const token of tokens) {
      const path = projectPath(token, home);
      if (path === undefined) continue;
      named.push(directory === "" || token.startsWith(`${home}/`) ? path : `${directory}/${path}`);
    }
    if (tokens[0] === "cd" && tokens[1] !== undefined && !tokens[1].startsWith("/") && !tokens[1].startsWith("..")) {
      const target = withoutLeadingDot(tokens[1]);
      directory = directory === "" ? target : `${directory}/${target}`;
    }
  }
  return [...new Set(named)];
}

/** Whether the layout lists `path`, or stops short of a directory that could hold it (so it cannot be disproven). */
export function layoutAccepts(path: string, context: ProjectContext): boolean {
  const listed = new Set(context.Layout);
  const unlisted = new Set(context.Unlisted);
  let directory = "";
  for (const part of path.split("/")) {
    const here = `${directory}${part}`;
    if (listed.has(here) || listed.has(`${here}/`)) {
      directory = `${here}/`;
      continue;
    }
    return unlisted.has(directory.replace(/\/$/, ""));
  }
  return true;
}

/** The mise tasks a check runs with `mise run`. */
export function miseTasksRunBy(check: string): string[] {
  return [...check.matchAll(MISE_RUN)].map((match) => match[1]!);
}

/** Why each path or mise task a check names is not in the project; empty when all are. `label` names the check. */
export function groundingProblems(label: string, check: string, context: ProjectContext): string[] {
  const missing = pathsNamedBy(check, context.Home).filter((path) => !layoutAccepts(path, context)).map((path) =>
    `${label} names "${path}", which is not in the project's file listing: use a path from the listing`
  );
  const unknown = context.MiseTasks.length === 0
    ? []
    : miseTasksRunBy(check).filter((task) => !context.MiseTasks.includes(task)).map((task) =>
      `${label} runs mise task "${task}", which the project does not define: its tasks are ${
        context.MiseTasks.join(", ")
      }`
    );
  return [...missing, ...unknown];
}
