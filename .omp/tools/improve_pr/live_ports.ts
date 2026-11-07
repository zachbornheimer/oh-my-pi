import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileLedger, ledgerDirectory } from "./budget.js";
import { checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { type Runner, sleep, spawnRunner } from "./exec.js";
import type { ImprovePorts } from "./ports.js";

/** omp's default role. Literal `default` without `@` fails omp preflight. */
const OMP_DEFAULT_MODEL = "@default";
/** The overlay that keeps `modelFallback` on while a model is pinned; passed only when the file exists. */
export const PIN_MODEL = join(homedir(), ".omp/agent/overlays/pin-model.yml");

/** One agent run is stopped after this long (omp's own `--max-time` is set a little under it). */
export const AGENT_TIMEOUT_MS = 60 * 60_000;
const AGENT_MAX_TIME = "55m";

/**
 * Runs one coding task headless through a full omp process in `cwd`: `omp -p @<prompt file> --cwd <cwd> --model
 * @default`, no session file, no extensions. The prompt goes through a private temp file, never argv. Throws when omp
 * exits non-zero or is stopped; the temp directory is removed either way.
 */
export function ompAgent(run: Runner): ImprovePorts["agent"] {
  return async ({ cwd, prompt }) => {
    const directory = await mkdtemp(join(tmpdir(), "improve-pr-prompt-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const args = [
        "-p",
        `@${file}`,
        "--cwd",
        cwd,
        "--model",
        OMP_DEFAULT_MODEL,
        "--no-session",
        "--no-extensions",
        "--max-time",
        AGENT_MAX_TIME,
      ];
      if (existsSync(PIN_MODEL)) args.push("--config", PIN_MODEL);
      const result = await run("omp", args, {
        cwd,
        env: { ...process.env, AGENTMUX_NESTED_RUN: "1", LEARNER: "1" },
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      if (result.killed) throw new Error(`omp was stopped before it finished (limit ${AGENT_TIMEOUT_MS / 60_000} minutes, or cancelled)`);
      if (result.code !== 0) {
        throw new Error(`omp exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(-2_000)}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** The real `gh`, `git`, `ocr`, omp, spend ledger and clock. `progress` and `signal` come from the tool call. */
export function livePorts(options: { signal?: AbortSignal; progress: (message: string) => void }): ImprovePorts {
  const run = spawnRunner({ signal: options.signal });
  const root = checkoutRoot();
  return {
    run,
    checkout: (prUrl) => pullRequestCheckout(run, root, prUrl),
    agent: ompAgent(run),
    ledger: fileLedger(ledgerDirectory()),
    now: () => Date.now(),
    sleep: (ms) => sleep(ms, options.signal),
    progress: options.progress,
  };
}
