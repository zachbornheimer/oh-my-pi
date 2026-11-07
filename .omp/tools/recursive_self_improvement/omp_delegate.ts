import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One step that belongs to another native omp tool: a full `omp -p` session (every tool on) is told to call that tool once and
 * print its result. A custom tool cannot call another tool directly, so this is the only composition path. The reply is free
 * text: it is parsed as one JSON object and handed to `validate`, which throws to reject; a missing tool, a refusal or prose
 * fails the step explicitly and nothing is guessed out of it.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

export function delegatePrompt(tool: string, args: unknown): string {
  return [
    `Call the omp tool \`${tool}\` exactly once with exactly these arguments:`,
    JSON.stringify(args),
    "",
    `Call it directly by its own name. NEVER use tool_call, capability/*, an MCP twin or any other tool in its place, and do not do the work yourself.`,
    `If \`${tool}\` is not available to you or it fails, reply with only {"error":"<the reason>"}.`,
    "When it returns, reply with only its result as one JSON object: the tool's structured details if shown, otherwise the JSON in its text. No prose, no code fence.",
  ].join("\n");
}

/** The one JSON object a reply carries: the reply itself, a lone fenced block, or the outermost braces. */
export function parseObjectReply(reply: string): Record<string, unknown> {
  const text = reply.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`the reply carries no JSON object: ${body.slice(0, 160)}`);
  let value: unknown;
  try {
    value = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the reply is not JSON (${(error as Error).message}): ${body.slice(0, 160)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the reply is not a JSON object");
  return value as Record<string, unknown>;
}

export async function delegateToolCall<T>(
  exec: Exec,
  request: { tool: string; args: unknown; validate: (value: Record<string, unknown>) => T; timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<T> {
  request.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "omp-delegate-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, delegatePrompt(request.tool, request.args), { mode: 0o600 });
    const result = await exec("omp", ["-p", `@${file}`, "--no-session", "--no-title", "--no-pty"], {
      signal: request.signal,
      timeout: request.timeoutMs,
      cwd: request.cwd ?? directory,
    });
    if (result.killed) {
      request.signal?.throwIfAborted();
      throw new Error(`${request.tool} was killed after ${Math.round(request.timeoutMs / 1000)} s`);
    }
    if (result.code !== 0) throw new Error(`omp exited ${result.code} running ${request.tool}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
    const object = parseObjectReply(result.stdout);
    if (typeof object.error === "string" && Object.keys(object).length === 1) throw new Error(`${request.tool}: ${object.error}`);
    return request.validate(object);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
