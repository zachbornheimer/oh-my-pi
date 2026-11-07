import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The agent step of a tool: one FULL `omp -p @<prompt file>` session (no bare flags), so the agent keeps the tools,
 * skills and rules of this machine and can read files and run commands. The prompt file lives in a private temporary
 * directory removed afterwards. The reply is free text; the caller validates what it needs from it.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** The shape of `pi.exec`. */
export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

/** Sends one prompt to a full omp session and returns its reply text. */
export type AgentStep = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Longest one review session may run before it is killed. */
export const SESSION_TIMEOUT_MS = 45 * 60_000;

/** An agent step that spawns `omp -p @<prompt file>` in a private temporary directory removed afterwards. */
export function ompSessionStep(exec: Exec, options: { timeoutMs?: number; label?: string } = {}): AgentStep {
  const timeoutMs = options.timeoutMs ?? SESSION_TIMEOUT_MS;
  const label = options.label ?? "omp session";
  return async (prompt, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "omp-agent-session-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const result = await exec("omp", ["-p", `@${file}`], { signal, timeout: timeoutMs, cwd: directory });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`${label} was killed after ${timeoutMs / 1000} s`);
      }
      if (result.code !== 0) {
        throw new Error(`${label} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      const reply = result.stdout.trim();
      if (reply === "") throw new Error(`${label} returned no text`);
      return reply;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Runs `work` over `items` with at most `limit` in flight; results keep the order of `items`. The first failure
 * rejects the whole call and no item that has not started is started afterwards.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Interval between progress updates while a long step runs. */
export const HEARTBEAT_MS = 15_000;

export type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Runs `work`, sending `onUpdate` a progress line every `intervalMs` until it settles; the timer is always cleared. */
export async function withHeartbeat<T>(
  onUpdate: Update | undefined,
  label: () => string,
  work: () => Promise<T>,
  intervalMs: number = HEARTBEAT_MS,
): Promise<T> {
  const began = Date.now();
  const beat = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text", text: `${label()} (${Math.round((Date.now() - began) / 1000)} s)` }],
      details: { status: "running" },
    });
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}

/** The prompt text file shipped next to the tool. */
export async function promptFile(url: URL): Promise<string> {
  return readFile(url, "utf8");
}
