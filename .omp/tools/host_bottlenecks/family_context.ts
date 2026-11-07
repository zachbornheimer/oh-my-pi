import { gitTrigger, hookPhaseOf, invocationOf } from "./process_command.ts";
import type { ProcessTree } from "./process_tree.ts";
import type { Family, ProcessSample } from "./types.ts";

/** Arguments that mean "everything under the working directory". */
export const WHOLE_TREE_ARGUMENTS: readonly string[] = [".", "./...", "--all", "-a"];

const PATH_SEPARATOR = "/";
const FILE_EXTENSION = /\.\w+$/;
const GLOB = "*";
const URL_MARKER = "://";
const WORKTREE_COMMAND = "wt";
const CRON_COMMAND = "cron";
const CHANGED_FILES_RUNNER = "hk";
const LAUNCHD_COMMAND = "launchd";

const isGlob = (argument: string): boolean => argument.includes(GLOB);
const isWholeTree = (argument: string): boolean => WHOLE_TREE_ARGUMENTS.includes(argument);
const looksLikePath = (argument: string): boolean =>
  !argument.startsWith("-") && !argument.includes(URL_MARKER) && !isWholeTree(argument) && !isGlob(argument)
  && (argument.includes(PATH_SEPARATOR) || FILE_EXTENSION.test(argument));

/** What a gate or test command was pointed at: how many paths it was given, and whether that is the whole tree. */
export function scopeOf(command: string): NonNullable<Family["scope"]> {
  const { base, args } = invocationOf(command);
  const invoked_files = args.filter(looksLikePath).length;
  const named = args.some((argument) => isWholeTree(argument) || isGlob(argument));
  // `hk run <phase>` works on the changed files unless told otherwise, so no file argument is not the whole tree.
  return { invoked_files, whole_tree: named || (invoked_files === 0 && base !== CHANGED_FILES_RUNNER) };
}

function otherTrigger(
  process: ProcessSample,
  tree: ProcessTree,
  shellSeen: boolean,
): string | undefined {
  const { base } = invocationOf(process.command);
  if (base === WORKTREE_COMMAND) return base;
  const phase = hookPhaseOf(process.command);
  if (base === "hk" && phase !== undefined) return `hk run ${phase}`;
  if (tree.kind(process.pid) === "harness") return `${base} session`;
  if (base === CRON_COMMAND) return base;
  return base === LAUNCHD_COMMAND && !shellSeen ? base : undefined;
}

/**
 * What started the work, read up the chain from the process that does it: a git commit, push or merge when there is
 * one, else the nearest worktree command, hook run, agent session, cron or launchd.
 */
export function triggerOf(chain: readonly ProcessSample[], tree: ProcessTree): string | undefined {
  for (const process of chain) {
    const git = gitTrigger(process.command);
    if (git !== undefined) return git;
  }
  let shellSeen = false;
  for (const process of chain) {
    const found = otherTrigger(process, tree, shellSeen);
    if (found !== undefined) return found;
    shellSeen ||= tree.kind(process.pid) === "shell";
  }
  return undefined;
}

/** The hook phase (`pre-push`) the nearest process in the chain runs for. */
export function hookPhaseInChain(chain: readonly ProcessSample[]): string | undefined {
  for (const process of chain) {
    const phase = hookPhaseOf(process.command);
    if (phase !== undefined) return phase;
  }
  return undefined;
}
