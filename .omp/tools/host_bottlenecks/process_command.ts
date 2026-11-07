import type { ProcessKind } from "./types.ts";

/**
 * The commands of each kind, by lower-cased base name. A two-word entry (`go test`) names a command with its first
 * argument; a trailing `*` matches any base that starts with the rest. First kind to match wins.
 */
export const KIND_COMMANDS: ReadonlyArray<readonly [ProcessKind, readonly string[]]> = [
  ["harness", ["claude", "grok", "codex", "hermes", "cursor", "code", "opencode"]],
  [
    "gate",
    [
      "hk",
      "dprint",
      "prettier",
      "eslint",
      "golangci-lint",
      "ruff",
      "trunk",
      "semgrep",
      "trufflehog",
      "gitleaks",
      "shellcheck",
      "tsc",
    ],
  ],
  ["test", ["go test", "vitest", "pytest", "jest"]],
  ["build", ["go build", "esbuild", "tsx", "cargo", "swift"]],
  ["model_server", ["ollama", "llama-server", "mlx"]],
  ["vm", ["com.apple.virtualization.virtualmachine", "colima", "qemu", "limactl"]],
  ["mcp", ["docker-mcp", "docker", "mcp-*"]],
  ["sync", ["dropbox", "cloudd", "bird", "fileproviderd"]],
  ["indexer", ["mds", "mds_stores", "mdworker*", "spotlight"]],
  ["system", ["kernel_task", "windowserver", "launchd", "coreaudiod"]],
  ["shell", ["zsh", "bash", "sh", "tmux", "kitty", "terminal"]],
  ["git", ["git", "wt"]],
];

/** Kinds whose processes own the processes they start: a family is rooted at the nearest one. */
export const ROOT_KINDS: readonly ProcessKind[] = ["harness", "mcp", "vm", "model_server", "sync", "indexer", "git"];

/** Programs that run a script: the script, not the program, says what is running. */
const INTERPRETERS: readonly string[] = ["node", "bun", "deno", "python", "python3", "ruby", "perl"];

const APP_BUNDLE = ".app/";
const MCP_WORD = /mcp/i;
const BUILD_WORD = /\b(build|bundle)\b/;
const HOOK_SCRIPT = /(?:^|[\s/])(pre-commit|pre-push|commit-msg)(?=\s|$)/;
const GIT_TRIGGER_VERBS: readonly string[] = ["commit", "push", "merge"];

/** A command line split into what runs and what it was given. */
export interface Invocation {
  /** The program's base name, or the script's when a program runs one. */
  readonly base: string;
  readonly args: readonly string[];
  /** The program that ran the script (`node`), when one did. */
  readonly interpreter?: string;
}

const baseOf = (path: string): string => path.split("/").pop() ?? path;

/** The program of a command; a macOS app's path may hold spaces, so it ends at the first option. */
function programOf(command: string): { readonly program: string; readonly rest: string } {
  if (command.startsWith("/") && command.includes(APP_BUNDLE)) {
    const optionAt = command.search(/ -/);
    const end = optionAt < 0 ? command.length : optionAt;
    return { program: command.slice(0, end), rest: command.slice(end) };
  }
  const words = command.trim().split(/\s+/);
  return { program: words[0] ?? "", rest: command.trim().slice((words[0] ?? "").length) };
}

export function invocationOf(command: string): Invocation {
  const { program, rest } = programOf(command);
  const words = rest.trim() === "" ? [] : rest.trim().split(/\s+/);
  const base = baseOf(program);
  if (!INTERPRETERS.includes(base.toLowerCase().replace(/[\d.]+$/, ""))) return { base, args: words };
  const scriptAt = words.findIndex((word) => !word.startsWith("-"));
  if (scriptAt < 0) return { base, args: words };
  return { base: baseOf(words[scriptAt]!), args: words.slice(scriptAt + 1), interpreter: base };
}

function kindListed(key: string): ProcessKind | undefined {
  return KIND_COMMANDS.find(([, commands]) =>
    commands.some((command) => command.endsWith("*") ? key.startsWith(command.slice(0, -1)) : command === key)
  )?.[0];
}

/** The kind of a command: by its base name, told apart from its arguments for `go`, `node` and the like. */
export function kindOf(command: string): ProcessKind {
  const { base, args, interpreter } = invocationOf(command);
  const lower = base.toLowerCase();
  const listed = kindListed(`${lower} ${args[0] ?? ""}`) ?? kindListed(lower);
  if (listed !== undefined) return listed;
  if (interpreter?.toLowerCase() !== "node") return "other";
  if (MCP_WORD.test(command)) return "mcp";
  return BUILD_WORD.test(args.join(" ")) ? "build" : "other";
}

/** The first word after `git` (and its options) that names what git does: `commit`, `push`. */
export function gitVerb(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (word === "-C" || word === "-c") at++;
    else if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/** `git commit`, `git push` or `git merge` when the command is one of them. */
export function gitTrigger(command: string): string | undefined {
  const { base, args } = invocationOf(command);
  if (base !== "git") return undefined;
  const verb = gitVerb(args);
  return verb !== undefined && GIT_TRIGGER_VERBS.includes(verb) ? `git ${verb}` : undefined;
}

/** The phase of `hk run <phase>`, or the hook script (`pre-push`) a command runs. */
export function hookPhaseOf(command: string): string | undefined {
  const { base, args } = invocationOf(command);
  if (base === "hk" && args[0] === "run" && args[1] !== undefined) return args[1];
  return HOOK_SCRIPT.exec(command)?.[1];
}
