/** Turns a shell command into the program and arguments the rest of the module reads. */

const COMMAND_SEPARATOR = /&&|\|\||;|\||\n/;
/** `FOO=bar` assignments that precede a program. */
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
/** A redirect that writes nothing a reader would call a change: `2>&1`, `>/dev/null`, `2>/dev/null`. */
const HARMLESS_REDIRECT = /\d*>\s*&\d|\d*>>?\s*\/dev\/null/g;
const WRITING_REDIRECT = />/;

/** Programs that only look: they change nothing on the machine. */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "cat",
  "ls",
  "rg",
  "grep",
  "head",
  "tail",
  "fd",
  "wc",
  "pwd",
  "which",
  "stat",
  "file",
  "tree",
  "du",
  "jq",
  "less",
  "bat",
  "cd",
  "echo",
]);
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "rev-parse"]);
const GIT = "git";
const SED = "sed";
const SED_QUIET_FLAG = "-n";
const SED_IN_PLACE_FLAG = /^-[a-zA-Z]*i/;

/** The words of a command, with the `FOO=bar` prefix and a leading `time` or `env` left out. */
export function wordsOf(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter((word) => word !== "");
  let start = 0;
  while (start < words.length && (ENVIRONMENT_ASSIGNMENT.test(words[start]!) || words[start] === "time")) start += 1;
  return words.slice(start);
}

const basename = (program: string): string => program.slice(program.lastIndexOf("/") + 1);

function segmentIsReadOnly(segment: string): boolean {
  if (WRITING_REDIRECT.test(segment.replace(HARMLESS_REDIRECT, ""))) return false;
  const [program, ...rest] = wordsOf(segment);
  if (program === undefined) return true;
  const name = basename(program);
  if (name === GIT) return READ_ONLY_GIT_SUBCOMMANDS.has(rest.find((word) => !word.startsWith("-")) ?? "");
  if (name === SED) return rest.includes(SED_QUIET_FLAG) && !rest.some((word) => SED_IN_PLACE_FLAG.test(word));
  return READ_ONLY_PROGRAMS.has(name);
}

/**
 * Whether every part of a command only looks (`cat`, `ls`, `rg`, `grep`, `head`, `sed -n`, `git status|log|diff`, ...):
 * such a command is exploration, not a step of a process. A redirect that writes a file makes it a change.
 */
export function isReadOnlyCommand(command: string): boolean {
  return command.split(COMMAND_SEPARATOR).every(segmentIsReadOnly);
}

/** A command with its whitespace collapsed, so the same command typed twice compares equal. */
export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, " ");

const SHELL_WRAPPERS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"]);
const SHELL_COMMAND_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc", "-ic", "-lic"]);

/** The command a shell tool's arguments name: `command` / `cmd` as a string, or as an argv (`["bash", "-lc", "..."]`). */
export function commandOf(input: Readonly<Record<string, unknown>>): string | undefined {
  const wire = input.command ?? input.cmd;
  if (typeof wire === "string") return wire.trim() === "" ? undefined : wire;
  if (!Array.isArray(wire) || !wire.every((word): word is string => typeof word === "string")) return undefined;
  const [program, flag, script] = wire;
  if (wire.length === 3 && program !== undefined && SHELL_WRAPPERS.has(program) && SHELL_COMMAND_FLAGS.has(flag!)) {
    return script;
  }
  return wire.join(" ");
}

/** A word that names a subcommand (`check`, `run`), not a value (`shop.example.com`, a URL, a path). */
const SUBCOMMAND_WORD = /^[a-z][a-z-]*$/;

/** `scripts/smoke.sh`, `mise run`, `webmaster check`: the program, plus its subcommand when it has one. */
export function commandLabel(command: string): string {
  const [first = ""] = command.split(COMMAND_SEPARATOR);
  const [program = "", next] = wordsOf(first);
  return next !== undefined && SUBCOMMAND_WORD.test(next) ? `${program} ${next}` : program;
}
