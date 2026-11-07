import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two ways this tool runs a model, both as one `omp -p` child process reading a prompt file in a private temporary
 * directory (removed afterwards): a bare completion (no tools, no extensions) for the review steps, whose JSON reply is
 * validated in code, and a full agent session in the worktree for the implementer.
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

/** Runs one coding task in a full omp session in `cwd`; resolves when it finished, throws when it failed. */
export type AgentStep = (input: { cwd: string; prompt: string }, signal?: AbortSignal) => Promise<void>;

/** Longest one bare model call may run before it is killed. */
export const MODEL_TIMEOUT_MS = 450_000;
/** How many times a reply that fails validation is asked again, the reason shown, before the step fails. */
export const MODEL_ATTEMPTS = 3;
/** Longest the implementer's agent session may run. */
export const AGENT_TIMEOUT_MS = 60 * 60_000;
const AGENT_MAX_TIME = "55m";
/** omp's default role. Literal `default` without `@` fails omp preflight. */
const OMP_DEFAULT_MODEL = "@default";

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

/** The overlay that keeps `modelFallback` on while a model is pinned; passed only when the file exists. */
export function pinModelOverlay(home = homedir()): string | undefined {
  const file = join(home, ".omp/agent/overlays/pin-model.yml");
  return existsSync(file) ? file : undefined;
}

async function withPromptFile<T>(prompt: string, run: (file: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "execute-ticket-prompt-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, prompt, { mode: 0o600 });
    return await run(file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A bare completion: `omp -p @<prompt file>` with every tool, extension, skill, rule and context file off. */
export function ompModelStep(exec: Exec, options: { timeoutMs?: number } = {}): ModelStep {
  const timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS;
  return async (prompt, signal) => {
    signal?.throwIfAborted();
    return withPromptFile(prompt, async (file, directory) => {
      const result = await exec("omp", ["-p", `@${file}`, ...BARE_OMP_FLAGS], { signal, timeout: timeoutMs, cwd: directory });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`model step was killed after ${timeoutMs / 1000} s`);
      }
      if (result.code !== 0) {
        throw new Error(`model step exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      const reply = result.stdout.trim();
      if (reply === "") throw new Error("model step returned no text");
      return reply;
    });
  };
}

/** A full omp session in `cwd`: it has omp's file and shell tools, no session file, no extensions. */
export function ompAgentStep(exec: Exec, options: { timeoutMs?: number; pinModel?: string | undefined } = {}): AgentStep {
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  const pin = "pinModel" in options ? options.pinModel : pinModelOverlay();
  return async ({ cwd, prompt }, signal) => {
    signal?.throwIfAborted();
    await withPromptFile(prompt, async (file) => {
      const args = ["-p", `@${file}`, "--cwd", cwd, "--model", OMP_DEFAULT_MODEL, "--no-session", "--no-extensions", "--max-time", AGENT_MAX_TIME];
      if (pin !== undefined) args.push("--config", pin);
      const result = await exec("omp", args, { signal, timeout: timeoutMs, cwd });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`omp was stopped before it finished (limit ${timeoutMs / 60_000} minutes)`);
      }
      if (result.code !== 0) {
        throw new Error(`omp exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(-2_000)}`);
      }
    });
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

/** Interval between progress updates while a long step runs. */
export const HEARTBEAT_MS = 15_000;

type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Runs `work`, sending `onUpdate` a progress line every HEARTBEAT_MS until it settles; the timer is always cleared. */
export async function withHeartbeat<T>(
  onUpdate: Update | undefined,
  label: () => string,
  work: () => Promise<T>,
  intervalMs = HEARTBEAT_MS,
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
