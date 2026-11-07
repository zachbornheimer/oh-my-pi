import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLedger, ledgerDirectory } from "./budget.js";
import { checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { PUSH_HOOK_BUDGET_MS, ROUND_AGENT_BUDGET_MS, ROUND_BUDGET_EXIT } from "./constants.js";
import { command, DEFAULT_COMMAND_TIMEOUT_MS, type Runner, sleep, spawnRunner } from "./exec.js";
import type { PrPorts } from "./ports.js";

/**
 * The environment of the host's push. A pre-push hook that reads GitHub (pinact listing a private reusable workflow's
 * tags) gets the `gh` login's token, as it does in the agent's own shell, so a push is judged on the same findings the
 * agent saw instead of failing on a 404 no edit can fix. Without a `gh` login the push runs as before.
 */
export async function pushEnv(run: Runner): Promise<NodeJS.ProcessEnv> {
  const token = (await command(run, "gh", ["auth", "token"]).catch(() => "")).trim();
  return token === "" ? process.env : { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token };
}

/**
 * One round's wait on its omp, bounded: an agent that idles — a gate it waits on with sleep polls, a wedged tool — is
 * stopped at `budgetMs` and reported as `ROUND_BUDGET_EXIT`, the way `timeout(1)` reports 124, instead of holding the
 * round silently for hours. The stop is a SIGTERM and the status returns at once: the stopped round is failed and never
 * pushed, and the next round's checkout reset discards whatever it leaves. A cancelled run throws instead. The prompt
 * goes to omp through a private temp file, never argv; the file is removed either way.
 */
export async function ompRoundStatus(
  run: Runner,
  input: { cwd: string; prompt: string; role: string; budgetMs: number; signal?: AbortSignal },
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "make-pr-mergable-prompt-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, input.prompt, { mode: 0o600 });
    const result = await run("omp", ["-p", `@${file}`, "--cwd", input.cwd, "--model", input.role], {
      cwd: input.cwd,
      timeoutMs: input.budgetMs,
      signal: input.signal,
    });
    if (result.killed) {
      if (input.signal?.aborted === true) throw new Error("make_pr_mergable was cancelled");
      return ROUND_BUDGET_EXIT;
    }
    return result.code;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The real `gh`, `git`, omp, spend ledger and clock. Its omp role comes from the round, never from the caller. */
export function livePorts(options: { signal?: AbortSignal; progress: (message: string) => void }): PrPorts {
  const run = spawnRunner({ signal: options.signal });
  const root = checkoutRoot();
  return {
    gh: (args) => command(run, "gh", args, { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }),
    git: async (args, cwd) =>
      args[0] === "push"
        ? command(run, "git", ["-C", cwd, ...args], { timeoutMs: PUSH_HOOK_BUDGET_MS, env: await pushEnv(run) })
        : command(run, "git", ["-C", cwd, ...args], { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }),
    checkout: (prUrl) => pullRequestCheckout(run, root, prUrl),
    runAgent: ({ cwd, prompt, role }) =>
      ompRoundStatus(run, { cwd, prompt, role, budgetMs: ROUND_AGENT_BUDGET_MS, signal: options.signal }),
    ledger: fileLedger(ledgerDirectory()),
    now: () => new Date(),
    sleep: (ms) => sleep(ms, options.signal),
    progress: options.progress,
  };
}
