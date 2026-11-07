import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The model step of the learn chain: one FULL `omp -p @<prompt file>` session (no bare flags), because every question the
 * chain asks needs real tools: the forensics threads read the annotated transcript and the repository, the PM threads read
 * the forensics conversation, search and update Linear, and verify code. A full session returns free text, so the answer
 * travels through an explicit channel: the prompt names a private answer file, the session writes its JSON there, and this
 * module hands the file's text back. A session that wrote nothing fails with its own last words named; nothing is ever read
 * out of prose.
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

/** Longest one agent session may run before it is killed. */
export const AGENT_TIMEOUT_MS = 2_400_000;

/** The model role every learn session runs on: the agent definitions' own `model: ['@task']`. */
export const AGENT_MODEL = "@task";

export interface AgentRequest {
  /** The whole prompt, given the absolute path of the answer file the session must write. */
  readonly prompt: (answerFile: string) => string;
  readonly signal?: AbortSignal;
}

/** Runs one session and returns the text of the answer file it wrote. */
export type AgentStep = (request: AgentRequest) => Promise<string>;

export interface AgentStepOptions {
  readonly timeoutMs?: number;
  /** The session's working directory. */
  readonly cwd?: string;
  /** Directories granted to the session beside its working directory (`--add-dir`). */
  readonly addDirs?: readonly string[];
}

/** An `AgentStep` over `omp`: private temp dir for prompt and answer, argv array, timeout, signal, cleanup in `finally`. */
export function ompAgentStep(exec: Exec, options: AgentStepOptions = {}): AgentStep {
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  return async ({ prompt, signal }) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "omp-learn-step-"));
    try {
      const promptFile = join(directory, "prompt.md");
      const answerFile = join(directory, "answer.json");
      await writeFile(promptFile, prompt(answerFile), { mode: 0o600 });
      const args = ["--auto-approve", "--model", AGENT_MODEL, "--add-dir", directory];
      for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
      args.push("-p", `@${promptFile}`);
      const result = await exec("omp", args, {
        signal,
        timeout: timeoutMs,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`agent session was killed after ${Math.round(timeoutMs / 1000)} s`);
      }
      if (result.code !== 0) {
        throw new Error(`agent session exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      let text: string;
      try {
        text = await readFile(answerFile, "utf8");
      } catch {
        throw new AnswerMissing(
          `the session finished without writing its answer to ${answerFile}; its last words: ${result.stdout.trim().slice(-400) || "(none)"}`,
        );
      }
      if (text.trim() === "") throw new AnswerMissing("the session wrote an empty answer file");
      return text;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** The session ended without the answer file: a shape failure the thread may ask again, unlike a crash. */
export class AnswerMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerMissing";
  }
}

/** The JSON an answer file holds: the whole file, or the one fenced block that is the whole file. Anything else throws. */
export function parseAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`the answer file is not JSON (${(error as Error).message}): ${body.slice(0, 120)}`);
  }
}

/** Interval between progress updates while a long step runs. */
export const HEARTBEAT_MS = 15_000;

export type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** The latest-state sink the chain reports into; the tool's heartbeat timer reads what was last said. */
export type Report = (message: string) => void;
