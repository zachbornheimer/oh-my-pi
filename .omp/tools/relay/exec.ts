/** The shape of `pi.exec`; tests substitute a fake. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecOptions = { signal?: AbortSignal; timeout?: number; cwd?: string };

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Budget of one external command when a caller names none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** The programs `command` runs. A closed set: a name outside it is a compile error, and a runtime one is refused. */
export type CommandProgram = "gh" | "git";

/** One literal call per allowed program, so no caller-chosen name ever reaches the host's `exec`. */
function execProgram(exec: Exec, program: CommandProgram, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  switch (program) {
    case "gh":
      return exec("gh", [...args], options);
    case "git":
      return exec("git", [...args], options);
    default:
      throw new Error(`refusing to run ${String(program)}: not one of gh, git`);
  }
}

/**
 * Runs a program and returns its stdout, or throws. The message is `Command failed: <program and first three
 * arguments>` and then the tail of stderr (else stdout), so a caller can classify the failure by what the program said.
 */
export async function command(
  exec: Exec,
  program: CommandProgram,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<string> {
  const label = `${program} ${args.slice(0, 3).join(" ")}`.trim();
  const result = await execProgram(exec, program, args, { timeout: DEFAULT_COMMAND_TIMEOUT_MS, ...options });
  if (result.killed) {
    throw new Error(
      options.signal?.aborted === true ? `${label} was cancelled` : `Command failed: ${label}\ntimed out after ${options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS} ms`,
    );
  }
  if (result.code !== 0) {
    const said = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(-8_000);
    throw new Error(`Command failed: ${label} (exit ${result.code})\n${said}`);
  }
  return result.stdout;
}

/** Waits `ms`; rejects at once when `signal` aborts. The timer is always cleared. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new Error("cancelled"));
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Error("cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
