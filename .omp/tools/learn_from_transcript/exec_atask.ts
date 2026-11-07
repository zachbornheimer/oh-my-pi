import type { Exec } from "./omp_agent.js";
import type { AtaskRun, RunAtask } from "./start_task/atask_cli.js";

/** One atask call's bound; a filing reads or writes one task, so a minute is generous. */
export const ATASK_TIMEOUT_MS = 60_000;

/**
 * The `atask` CLI through `pi.exec`: argv in, an `AtaskRun` out, nothing interpreted by a shell. A binary that cannot start
 * is a `spawnError` run (named by `ataskEnvelope`), a timeout is a failed run saying so, and an aborted `signal` rethrows.
 */
export function execAtask(exec: Exec, options: { readonly cwd?: string; readonly signal?: AbortSignal } = {}): RunAtask {
  return async (argv, call): Promise<AtaskRun> => {
    const signal = call?.signal ?? options.signal;
    signal?.throwIfAborted();
    const timeout = call?.timeoutMs ?? ATASK_TIMEOUT_MS;
    const cwd = call?.cwd ?? options.cwd;
    let result;
    try {
      result = await exec("atask", [...argv], { signal, timeout, ...(cwd === undefined ? {} : { cwd }) });
    } catch (error) {
      signal?.throwIfAborted();
      return { code: 1, stdout: "", stderr: "", spawnError: error instanceof Error ? error.message : String(error) };
    }
    if (result.killed) {
      signal?.throwIfAborted();
      return { code: 1, stdout: result.stdout, stderr: `atask ${argv[0] ?? ""} was killed after ${Math.round(timeout / 1000)} s` };
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}
