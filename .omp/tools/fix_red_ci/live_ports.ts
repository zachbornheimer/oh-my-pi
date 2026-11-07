import { fileLedger, ledgerDirectory } from "./budget.js";
import { checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { FIX_MODEL_ROLE, PUSH_HOOK_BUDGET_MS } from "./constants.js";
import { command, DEFAULT_COMMAND_TIMEOUT_MS, type Runner, sleep, spawnRunner } from "./exec.js";
import { ompModelStep } from "./omp_model.js";
import type { PrPorts } from "./ports.js";

/**
 * The environment of the host's push. A pre-push hook that reads GitHub (pinact listing a private reusable workflow's
 * tags) gets the `gh` login's token, so a push is judged on the same findings a developer's shell sees instead of failing
 * on a 404 no edit can fix. Without a `gh` login the push runs as before.
 */
export async function pushEnv(run: Runner): Promise<NodeJS.ProcessEnv> {
  const token = (await command(run, "gh", ["auth", "token"]).catch(() => "")).trim();
  return token === "" ? process.env : { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token };
}

/** The real `gh`, `git`, bare omp model step, spend ledger and clock. The model's role comes from the tool, never from the caller. */
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
    model: ompModelStep(
      (program, args, runOptions) =>
        run(program, args, { cwd: runOptions?.cwd, timeoutMs: runOptions?.timeout, signal: runOptions?.signal }),
      { model: FIX_MODEL_ROLE },
    ),
    ledger: fileLedger(ledgerDirectory()),
    now: () => new Date(),
    sleep: (ms) => sleep(ms, options.signal),
    progress: options.progress,
  };
}
