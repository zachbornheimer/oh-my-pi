import { basename } from "node:path";
import type { Exec } from "./omp.js";

/** Longest the repo's own gate may run before the round counts it as failed. */
export const GATE_TIMEOUT_MS = 20 * 60 * 1000;
const ORIGIN_PREFIX = "origin/";
/** How much of a failed command's output a fix prompt carries: its tail, where a hook or test runner names the failure. */
const MAX_FAILURE_CHARS = 6000;

/** The branch a ticket's worktree works on: one branch per ticket identifier. */
export function ticketBranch(identifier: string): string {
  return `ticket/${identifier.toLowerCase()}`;
}

/** What one ticket's repository work runs through: nothing else in this tool touches git for it. */
export interface RepoPort {
  /** The ticket's worktree on its own branch off the default branch; an existing one is reused. */
  worktree(ticket: { readonly identifier: string }): Promise<string>;
  /** The worktree's uncommitted diff, as `git diff HEAD` prints it. */
  diff(worktree: string): Promise<string>;
  /** Everything the branch changes against the default branch: what a reviewer judges. */
  branchDiff(worktree: string): Promise<string>;
  /** Stages and commits everything in the worktree; refuses an empty diff. A commit hook's refusal is an answer, not an error. */
  commit(worktree: string, message: string): Promise<CommitResult>;
  /** Pushes the branch and opens a pull request against the default branch; the answer is the PR's URL. */
  pullRequest(worktree: string, title: string, body: string): Promise<string>;
  /** The repo's own test gate, run inside the worktree, bounded by a timeout. */
  runTests(worktree: string): Promise<{ readonly ok: boolean; readonly output: string }>;
}

export type CommitResult =
  | { readonly committed: true; readonly sha: string }
  | { readonly committed: false; readonly refusal: string };

/** A command that exited non-zero (or was stopped), with what it printed. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly killed: boolean,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** What a failed command printed, stdout then stderr, cut to its tail: a runner may name the failure only on stderr. */
export function failureOutputOf(error: unknown): string | undefined {
  if (!(error instanceof CommandError)) return undefined;
  const printed = [error.stdout, error.stderr].filter((part) => part !== "");
  return (printed.join("\n") || error.message).slice(-MAX_FAILURE_CHARS);
}

/**
 * The repo port as git/gh argv: one worktree per ticket branch named `<repo>-ticket-<id>` in `worktreesDir`, diffs,
 * commit, push, and a pull request through `gh`. The default branch is read from `origin/HEAD`, never assumed.
 * `testCommand` is the repo's own gate, run as an argument array (no shell).
 */
export function repoPort(machine: {
  readonly exec: Exec;
  readonly root: string;
  /** Where `worktree` puts a ticket's checkout. */
  readonly worktreesDir: string;
  readonly testCommand: readonly string[];
  readonly signal?: AbortSignal;
  readonly gateTimeoutMs?: number;
}): RepoPort {
  const gateTimeoutMs = machine.gateTimeoutMs ?? GATE_TIMEOUT_MS;
  /** Runs one command; a non-zero exit throws a CommandError carrying both streams. */
  const run = async (command: string, args: readonly string[], cwd: string, timeout?: number): Promise<string> => {
    const result = await machine.exec(command, [...args], { cwd, signal: machine.signal, timeout });
    if (result.killed || result.code !== 0) {
      machine.signal?.throwIfAborted();
      const why = result.killed ? "was stopped" : `exited ${result.code}`;
      throw new CommandError(`${command} ${args.join(" ")} ${why}: ${result.stderr.trim()}`, result.stdout, result.stderr, result.killed);
    }
    return result.stdout;
  };

  /** Marks new files intent-to-add first: `git diff HEAD` alone never shows a file the implementer created. */
  const diff = async (worktree: string): Promise<string> => {
    await run("git", ["add", "--intent-to-add", "--", "."], worktree);
    return run("git", ["diff", "HEAD"], worktree);
  };

  let defaultBranch: string | undefined;
  const baseBranch = async (): Promise<string> => {
    if (defaultBranch !== undefined) return defaultBranch;
    const head = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], machine.root).then(
      (stdout) => stdout.trim(),
      () => "",
    );
    if (!head.startsWith(ORIGIN_PREFIX)) {
      throw new Error(`${machine.root}: no origin/HEAD; run \`git remote set-head origin -a\` there first`);
    }
    defaultBranch = head.slice(ORIGIN_PREFIX.length);
    return defaultBranch;
  };

  return {
    async worktree(ticket) {
      const branch = ticketBranch(ticket.identifier);
      const dir = `${machine.worktreesDir}/${basename(machine.root)}-ticket-${ticket.identifier.toLowerCase()}`;
      const reusable = await run("git", ["rev-parse", "--show-toplevel"], dir).then(() => true, () => false);
      if (reusable) return dir;
      const branchExists = await run("git", ["rev-parse", "--verify", branch], machine.root).then(() => true, () => false);
      try {
        await run(
          "git",
          branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, await baseBranch()],
          machine.root,
        );
      } catch (error) {
        // A setup hook can fail after git has checked the tree out; a half-set-up worktree left behind would be
        // reused by the next run as if it were ready.
        await run("git", ["worktree", "remove", "--force", dir], machine.root).catch(() => undefined);
        if (!branchExists) await run("git", ["branch", "-D", branch], machine.root).catch(() => undefined);
        throw new Error(`open worktree ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return dir;
    },
    diff,
    async branchDiff(worktree) {
      return run("git", ["diff", `${await baseBranch()}...HEAD`], worktree);
    },
    async commit(worktree, message) {
      if ((await diff(worktree)).trim() === "") throw new Error(`commit ${worktree}: nothing to commit`);
      await run("git", ["add", "-A"], worktree);
      try {
        return { committed: true, sha: (await run("git", ["commit", "-m", message], worktree)).trim() };
      } catch (error) {
        machine.signal?.throwIfAborted();
        return { committed: false, refusal: failureOutputOf(error) ?? "git commit failed" };
      }
    },
    async pullRequest(worktree, title, body) {
      const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim();
      await run("git", ["push", "-u", "origin", branch], worktree);
      const base = await baseBranch();
      return (await run("gh", ["pr", "create", "--title", title, "--body", body, "--base", base], worktree)).trim();
    },
    async runTests(worktree) {
      const [command, ...args] = machine.testCommand;
      if (command === undefined) throw new Error("the test gate command is empty");
      try {
        return { ok: true, output: await run(command, args, worktree, gateTimeoutMs) };
      } catch (error) {
        if (error instanceof CommandError && error.killed) {
          return { ok: false, output: `the gate ran past ${gateTimeoutMs / 60_000} minutes and was stopped` };
        }
        if (!(error instanceof CommandError)) throw error;
        return { ok: false, output: failureOutputOf(error) ?? "tests failed" };
      }
    },
  };
}
