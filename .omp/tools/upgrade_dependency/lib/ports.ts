import type { Ecosystem } from "./schemas.js";

// Port of agentmux internal/depupgrade/ports.go: the outside reads Gather performs, plus the process
// port the tree and peer adapters run through. Every read facts.ts makes goes through one of these; no
// facts logic calls a process, the filesystem or the network itself.

/** One line of a working copy that names a package: an import statement, or a call that runs its binary. */
export interface Invocation {
  path: string;
  line: number;
  statement: string;
}

/** One import statement of a package, as written in `path` at `line` (ports.go Import). */
export type Import = Invocation;

/** What a finished process left behind. `code` is the exit status; a process that could not start throws (system.Result). */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One command to run (system.CmdSpec). */
export interface Command {
  command: string;
  args: string[];
  /** The working directory; the caller's when unset. */
  dir?: string;
}

/**
 * The process port the rg and npm adapters (tree.ts, units.ts) run through. `run` never throws for a
 * non-zero exit — the exit code is on the result — and `lookPath` throws when the file is absent.
 */
export interface Process {
  run(command: Command): Promise<ProcessResult>;
  lookPath(file: string): Promise<string>;
}

/** Tree searches a working copy for how files import a package (tree.go Tree). */
export interface Tree {
  /** Every import statement of the package named `name`, including statements that span several lines. */
  imports(root: string, name: string): Promise<Import[]>;
  /** Every line that runs the package's command-line binary, in any language. */
  executions(root: string, name: string): Promise<Invocation[]>;
  /** The exported identifiers `path` uses through `qualifier` (Go: `qualifier.Name`). */
  identifiers(root: string, path: string, qualifier: string): Promise<string[]>;
}

/** ConfigFiles reads a repository's build configuration without running it. `readFile` throws when it cannot read the path. */
export interface ConfigFiles {
  readFile(path: string): Promise<string>;
}

/** Peers answers which packages a published package version requires its installer to provide (units.go Peers). */
export interface Peers {
  /** The peer ranges of `pkg@version`; `{}` when it declares none or the ecosystem has no peers. */
  of(eco: Ecosystem, pkg: string, version: string): Promise<Record<string, string>>;
}
