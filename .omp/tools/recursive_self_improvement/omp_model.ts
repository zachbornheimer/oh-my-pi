import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The model step of a tool: one `omp -p` child process that reads a prompt file and answers in text. It runs with
 * every tool, extension, skill, rule and context file switched off, so it is a plain completion and cannot recurse
 * into this tool or touch the machine. The reply is free text: `askJson` parses it as JSON and validates the shape
 * in code, retrying with the reason, and throws when no attempt is valid. Nothing is guessed out of prose.
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

/** Sends one prompt to a model and returns its reply text. */
export type ModelStep = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Longest one model call may run before it is killed. */
export const MODEL_TIMEOUT_MS = 300_000;
/** How many times a reply that fails validation is asked again, the reason shown, before the step fails. */
export const MODEL_ATTEMPTS = 3;

/** The flags that make `omp -p` a bare completion. */
export const BARE_OMP_FLAGS = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--no-lsp",
  "--no-pty",
] as const;

/** A model step that spawns `omp -p @<prompt file>` in a private temporary directory removed afterwards. */
export function ompModelStep(exec: Exec, options: { timeoutMs?: number } = {}): ModelStep {
  return async (prompt, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "omp-model-step-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const result = await exec("omp", ["-p", `@${file}`, ...BARE_OMP_FLAGS], {
        signal,
        timeout: options.timeoutMs ?? MODEL_TIMEOUT_MS,
        cwd: directory,
      });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`model step was killed after ${(options.timeoutMs ?? MODEL_TIMEOUT_MS) / 1000} s`);
      }
      if (result.code !== 0) {
        throw new Error(`model step exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      const reply = result.stdout.trim();
      if (reply === "") throw new Error("model step returned no text");
      return reply;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** The JSON a reply carries: the reply itself, or the one fenced block that is the whole reply. Anything else throws. */
export function parseJsonReply(reply: string): unknown {
  const text = reply.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced ? fenced[1]! : text;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`the reply is not JSON (${(error as Error).message}): ${body.slice(0, 120)}`);
  }
}

/**
 * Asks until the reply parses as JSON and `validate` accepts it. A rejected reply is asked again with the reason
 * appended, up to `attempts` calls; the last reason is the error. `validate` throws to reject.
 */
export async function askJson<T>(
  step: ModelStep,
  prompt: string,
  validate: (value: unknown) => T,
  options: { attempts?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? MODEL_ATTEMPTS;
  let request = prompt;
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const reply = await step(request, options.signal);
    try {
      return validate(parseJsonReply(reply));
    } catch (error) {
      reason = (error as Error).message;
      request = `${prompt}\n\nPrevious reply:\n${reply.slice(0, 2000)}\nYour previous reply was rejected: ${reason}\nAnswer again with only the JSON, corrected.`;
    }
  }
  throw new Error(`no valid reply after ${attempts} attempts: ${reason}`);
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
export const HEARTBEAT_MS = 10_000;

type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Runs `work`, sending `onUpdate` a progress line every HEARTBEAT_MS until it settles; the timer is always cleared. */
export async function withHeartbeat<T>(onUpdate: Update | undefined, label: string, work: () => Promise<T>): Promise<T> {
  const began = Date.now();
  const beat = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text", text: `${label} (${Math.round((Date.now() - began) / 1000)} s)` }],
      details: { status: "running" },
    });
  }, HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
