import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A model step that needs the user's own setup (Linear MCP tools, `gh`, the repositories): one full `omp -p` session, no
 * `--no-tools`. The prompt goes in through a private temporary file (never argv) that is removed afterwards. The reply
 * is free text, so it is parsed as exactly one JSON object and validated in code; a reply that is anything else is
 * rejected, never guessed at, and the question is asked again with the reason, up to `attempts` times.
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

export const HEARTBEAT_MS = 15_000;
export const SESSION_ATTEMPTS = 3;

export interface SessionOptions {
  /** Longest one session may run before it is killed. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Directory omp starts in; a private temporary one when absent. */
  cwd?: string;
  /** Keeps the session transcript under this directory; absent: nothing is saved. */
  sessionDir?: string;
  /** Extra workspace directories the session may read. */
  addDirs?: readonly string[];
  /** Names the run in an error. */
  label: string;
}

/** One headless full `omp -p` run; answers its stdout. Throws when it is stopped, cancelled or exits non-zero. */
export async function runOmpSession(exec: Exec, prompt: string, options: SessionOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "omp-ticket-session-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, prompt, { mode: 0o600 });
    const args = [
      "-p",
      `@${file}`,
      "--no-title",
      "--no-pty",
      options.sessionDir === undefined ? "--no-session" : `--session-dir=${options.sessionDir}`,
      ...(options.addDirs ?? []).map((dir) => `--add-dir=${dir}`),
    ];
    const result = await exec("omp", args, {
      signal: options.signal,
      timeout: options.timeoutMs,
      cwd: options.cwd ?? directory,
    });
    if (result.killed) {
      options.signal?.throwIfAborted();
      throw new Error(`${options.label} was stopped after ${Math.round(options.timeoutMs / 1000)} s`);
    }
    if (result.code !== 0) {
      throw new Error(
        `${options.label} (omp) exited ${result.code}: ${(result.stderr.trim() || result.stdout.trim() || "no output").slice(-2_000)}`,
      );
    }
    return result.stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The one JSON object a reply is: the reply itself, or a single fenced block that is the whole reply. Anything else throws. */
export function parseObjectReply(reply: string): Record<string, unknown> {
  const text = reply.trim();
  if (text === "") throw new Error("the reply is empty");
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced ? fenced[1]! : text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`the reply is not one JSON object (${(error as Error).message}): ${body.slice(0, 160)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the reply is not a JSON object");
  return value as Record<string, unknown>;
}

/**
 * Runs `prompt` and validates the reply. A reply that is not one JSON object or that `validate` rejects (it throws) is
 * asked again through `retry`, which gets the reason and the rejected reply. The last reason is the error. A session that
 * is killed or exits non-zero is not retried.
 */
export async function askObject<T>(
  exec: Exec,
  prompt: string,
  validate: (value: Record<string, unknown>) => T,
  options: SessionOptions & {
    attempts?: number;
    retry?: (reason: string, reply: string) => string;
  },
): Promise<T> {
  const attempts = options.attempts ?? SESSION_ATTEMPTS;
  let request = prompt;
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const reply = await runOmpSession(exec, request, options);
    try {
      return validate(parseObjectReply(reply));
    } catch (error) {
      reason = (error as Error).message;
      request = options.retry === undefined
        ? `${prompt}\n\nYour previous reply was rejected: ${reason}\nReply again with only the corrected JSON object.`
        : options.retry(reason, reply.slice(0, 2_000));
    }
  }
  throw new Error(`${options.label}: no valid reply after ${attempts} attempts: ${reason}`);
}

type OnUpdate = ((update: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined;

/** Sends a progress update every 15 s while `work` runs and clears the timer in every case. */
export async function withHeartbeat<T>(onUpdate: OnUpdate, label: string, work: () => Promise<T>): Promise<T> {
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

/** Tells a child session not to compose the ticket tools it shares with this tool: it would recurse. */
export const NO_RECURSION =
  "Use the Linear tools, `gh` and the repository directly. NEVER call the omp tools prepare_ticket, validate_ticket, "
  + "find_superseding_tickets, list_eligible_tickets, settle_ticket_outcome, relay or optimize_tooling, and never their "
  + "capability/Mastra twins: this run is one of their steps.";
