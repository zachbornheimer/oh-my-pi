/** What a finished process left behind. `code` is -1 when the process could not start. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The machine the tool runs on, as the dependency-upgrade code sees it: child processes and files, all rooted at one
 * working directory. Tests substitute a fake; `osHostMachine` is the real one.
 */
export interface HostMachine {
  /** The directory commands run in and relative paths resolve against. */
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** Runs `command` in `workingDirectory` with `env` added to the environment. Never throws for a non-zero exit. */
  run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<ProcessResult>;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  /** Writes `text` to the file, making the missing directories and replacing what was there. Throws naming the path. */
  writeTextFile(path: string, text: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** The names (not paths) inside the directory, sorted; empty when it is missing or unreadable. */
  listDirectory(path: string): Promise<string[]>;
  /** When the file last changed, in epoch milliseconds; undefined when it is missing or unreadable. */
  modifiedAtMs(path: string): Promise<number | undefined>;
  /** The file's lines, one at a time, so a file too big to hold as text can be read; undefined when it cannot be opened. */
  readLines(path: string): Promise<AsyncIterable<string> | undefined>;
  /** The environment variable's value, or undefined when it is unset. */
  environment(name: string): string | undefined;
}
