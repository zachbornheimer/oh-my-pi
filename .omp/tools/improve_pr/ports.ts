import type { Runner } from "./exec.js";
import type { SpendLedger } from "./budget.js";

/** Every effect `improve_pr` has. Tests substitute these; `live_ports.ts` is the real set. */
export interface ImprovePorts {
  /** Runs `gh`, `git` and `ocr`. */
  run: Runner;
  /** A private checkout of the pull request's head, detached at that commit and clean. */
  checkout(prUrl: string): Promise<string>;
  /** Runs one coding task through omp in `cwd` and resolves when omp finished it; throws when omp failed. */
  agent(input: { cwd: string; prompt: string }): Promise<void>;
  /** Lifetime USD per pull request, keyed by its URL. */
  ledger: SpendLedger;
  now(): number;
  /** Waits `ms`; rejects when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Tells whoever is watching what the run is doing now (the tool's heartbeat). */
  progress(message: string): void;
}
