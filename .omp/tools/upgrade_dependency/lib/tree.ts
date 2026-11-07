import type { Import, Invocation, Process } from "./ports.js";

// Port of agentmux internal/depupgrade/tree.go: Tree over rg. Ripgrep searches a working copy with rg
// through the process port; nothing here calls a process directly.

const RG_BIN = "rg";
const RG_NO_MATCH = 1;
const RG_MATCH_EVENT = "match";

/** rgExcludedGlobs keep vendored and generated trees out of every search. */
const RG_EXCLUDED_GLOBS = [
  "!node_modules/**",
  "!.git/**",
  "!dist/**",
  "!vendor/**",
  "!*.lock",
  "!package-lock.json",
  "!go.sum",
];

/** Go's regexp.QuoteMeta: escape the metacharacters with a backslash. */
export function quoteMeta(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * importStatementPattern matches ES imports and exports-from, require and dynamic import calls, and Go
 * import lines of the package name (tree.go importStatementPattern).
 */
export function importStatementPattern(name: string): string {
  const quote = "['\"`]";
  const target = quote + quoteMeta(name) + "(?:/[^'\"`]*)?" + quote;
  const es = "(?:import|export)[^;'\"`]*?\\bfrom\\s*" + target;
  const sideEffect = "import\\s*" + target;
  const call = "(?:require|import)\\s*\\(\\s*" + target + "\\s*\\)";
  const goLine = "^\\s*(?:import\\s+)?(?:[A-Za-z_.][A-Za-z0-9_]*\\s+)?\"" + quoteMeta(name) + "(?:/[^\"]*)?\"\\s*$";
  return [es, sideEffect, call, goLine].join("|");
}

/**
 * executionPattern matches a line that runs the package's command-line binary rather than importing it: a
 * `node_modules/.bin/` path (a script in another language naming the executable), a package runner, or the
 * name passed to a language's process call. None of the importers a code graph finds reach these lines, so
 * they are searched for apart.
 */
export function executionPattern(name: string): string {
  const target = quoteMeta(name);
  const bin = "node_modules/\\.bin/" + target;
  const runner = "\\b(?:npx|pnpx|bunx|dlx|yarn|pnpm|npm|bundle)\\s+(?:exec\\s+)?(?:-{1,2}[\\w-]+\\s+)*" + target
    + "\\b";
  const spawned = "\\b(?:Open3|Popen|capture3|check_output|subprocess|spawnSync|spawn|system|exec)\\b[^\\n]*" + target
    + "[_\\w]*";
  return [bin, runner, spawned].join("|");
}

interface RgEvent {
  type: string;
  data: {
    path: { text: string };
    line_number: number;
    submatches: { match: { text: string } }[];
  };
}

/** parseRgImports reads rg's JSON-lines output into the import statements it matched. */
export function parseRgImports(out: string): Import[] {
  const imports: Import[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") continue;
    const event = JSON.parse(line) as RgEvent;
    if (event.type !== RG_MATCH_EVENT) continue;
    const path = event.data.path.text.startsWith("./") ? event.data.path.text.slice(2) : event.data.path.text;
    for (const sub of event.data.submatches) {
      imports.push({ path, line: event.data.line_number, statement: sub.match.text });
    }
  }
  return imports;
}

/** Ripgrep implements Tree by searching a working copy with rg. */
export class Ripgrep {
  constructor(private readonly process: Process) {}

  /** Imports returns every import statement of `name` under `root`, including statements that span several lines. */
  async imports(root: string, name: string): Promise<Import[]> {
    if (name === "") return [];
    const args = ["--json", "--multiline"];
    for (const glob of RG_EXCLUDED_GLOBS) args.push("--glob", glob);
    args.push(importStatementPattern(name), ".");
    const out = await this.run(root, name, args);
    try {
      return parseRgImports(out);
    } catch (error) {
      throw new Error(`tree: parse rg output for ${name}: ${(error as Error).message}`, { cause: error });
    }
  }

  /** Executions returns every line that runs `name`'s command-line binary under `root`, in any language. */
  async executions(root: string, name: string): Promise<Invocation[]> {
    if (name === "") return [];
    const args = ["--json", "--multiline"];
    for (const glob of RG_EXCLUDED_GLOBS) args.push("--glob", glob);
    args.push(executionPattern(name), ".");
    const out = await this.run(root, name, args);
    try {
      return parseRgImports(out);
    } catch (error) {
      throw new Error(`tree: parse rg output for ${name}: ${(error as Error).message}`, { cause: error });
    }
  }

  /** Identifiers returns the distinct exported names `path` uses via `qualifier`. */
  async identifiers(root: string, path: string, qualifier: string): Promise<string[]> {
    const pattern = "\\b" + quoteMeta(qualifier) + "\\.([A-Z][A-Za-z0-9_]*)";
    const args = ["--only-matching", "--no-line-number", "--no-filename", "--replace", "$1", pattern, path];
    const out = await this.run(root, path, args);
    return out.split(/\s+/).filter((field) => field !== "");
  }

  private async run(root: string, subject: string, args: string[]): Promise<string> {
    let result;
    try {
      result = await this.process.run({ command: RG_BIN, args, dir: root });
    } catch (error) {
      throw new Error(`tree: search ${subject}: ${(error as Error).message}`, { cause: error });
    }
    if (result.code === RG_NO_MATCH) return "";
    if (result.code !== 0) {
      throw new Error(`tree: search ${subject}: exit ${result.code}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
}
