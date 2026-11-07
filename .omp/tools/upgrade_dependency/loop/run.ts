import { fileLedger, ledgerDirectory } from "./budget.js";
import { checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { PUSH_HOOK_BUDGET_MS, ROUND_AGENT_BUDGET_MS } from "./constants.js";
import { command, DEFAULT_COMMAND_TIMEOUT_MS, sleep, spawnRunner } from "./exec.js";
import { ompRoundStatus, pushEnv } from "./omp_round.js";
import type { PrPorts } from "./ports.js";
import type { Facts, Gate, PrGates, Status } from "./types.js";
import { driveToMergeable, stateText } from "./workflow.js";

export type { Facts, Gate, PrGates, PrPorts };

/** How a PR loop ended: the status, how many fix rounds ran, why it is not done, and a compact summary for the model. */
export interface PrLoopResult {
  status: Status;
  rounds: number;
  reasons: string[];
  text: string;
}

/**
 * The real `gh`, `git`, omp, spend ledger and clock. Its omp role comes from the round, never from the caller. The spend
 * ledger is shared with `make_pr_mergable` on purpose: lifetime dollars per pull request, whichever tool spent them.
 */
export function livePrPorts(options: { signal?: AbortSignal; progress: (message: string) => void }): PrPorts {
  const run = spawnRunner({ signal: options.signal });
  return {
    gh: (args) => command(run, "gh", args, { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }),
    git: async (args, cwd) =>
      args[0] === "push"
        ? command(run, "git", ["-C", cwd, ...args], { timeoutMs: PUSH_HOOK_BUDGET_MS, env: await pushEnv(run) })
        : command(run, "git", ["-C", cwd, ...args], { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }),
    checkout: checkoutForPr(options),
    runAgent: ({ cwd, prompt, role }) =>
      ompRoundStatus(run, { cwd, prompt, role, budgetMs: ROUND_AGENT_BUDGET_MS, signal: options.signal }),
    ledger: fileLedger(ledgerDirectory()),
    now: () => new Date(),
    sleep: (ms) => sleep(ms, options.signal),
    progress: options.progress,
  };
}

/**
 * A clean, detached checkout of the pull request's head in this tool's own cache tree (`loop/checkout.ts`). A repeated
 * call for the same pull request reuses the directory and discards whatever an earlier call left in it, so the caller
 * must not keep work there across calls.
 */
export function checkoutForPr(options: { signal?: AbortSignal }): (prUrl: string) => Promise<string> {
  const run = spawnRunner({ signal: options.signal });
  const root = checkoutRoot();
  return (prUrl) => pullRequestCheckout(run, root, prUrl);
}

/**
 * Drives one pull request to `mergeable` plus the caller's `gates`: reads it, works what blocks it in omp rounds (each
 * pushed once by the host), and waits for CI again, within `PR_BUDGET`. The gates are evaluated on every reading of an
 * open head, and a failed gate is an issue the next round works. It NEVER merges: `merged` only reports a pull request
 * that was already merged. A gate that throws rejects the run.
 */
export async function runPrLoop(ports: PrPorts, input: { prUrl: string; gates?: PrGates }): Promise<PrLoopResult> {
  const state = await driveToMergeable(ports, input);
  return { status: state.status, rounds: state.rounds.length, reasons: state.reasons, text: stateText(state) };
}
