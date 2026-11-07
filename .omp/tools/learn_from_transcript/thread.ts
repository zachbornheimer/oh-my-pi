import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AgentStep, AnswerMissing, type Report, parseAnswer } from "./omp_agent.js";
import { type QuestionFile, fieldsOf, promptTextOf } from "./questions.js";

/**
 * One agent thread of the learn chain: an ordered conversation whose turns are question files, answered by full omp
 * sessions. `omp -p` keeps no conversation between processes, so the thread owns it: every accepted turn is stored in the
 * thread's file (`{prompt, answer}` per line) and each later turn's session is shown the earlier questions and answers.
 * The stored file is also the conversation artifact the PM thread reads, and it is how a rerun skips turns it already has.
 */

/** How many times one question gets asked: its first ask plus the corrections a rejected answer draws. */
export const ANSWER_ATTEMPTS = 3;

/** Longest rejected answer the correction prompt quotes back. */
const QUOTED_ANSWER_CHARS = 4_000;

/** The turn state a whole run shares: after one turn diverges from the stored conversation, no later turn replays. */
export class RunTurns {
  #diverged = false;
  get diverged(): boolean {
    return this.#diverged;
  }
  diverge(): void {
    this.#diverged = true;
  }
}

export interface ThreadOptions {
  /** The conversation file: stored turns, and what a later thread is told to read. */
  readonly path: string;
  /** The agent definition's name, recorded in the file's header. */
  readonly role: string;
  /** The agent definition's instructions, placed first in every session prompt. */
  readonly preamble: string;
  readonly agent: AgentStep;
  readonly loadQuestions: (name: string) => Promise<QuestionFile>;
  readonly turns: RunTurns;
  readonly report?: Report;
  readonly attempts?: number;
  /** Aborts the run: handed to every agent session. */
  readonly signal?: AbortSignal;
}

export interface Thread {
  readonly path: string;
  /** Asks the question file `name` (rendered with `state`) and returns its validated fields. */
  prompt(name: string, state?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface StoredTurn {
  readonly question: string;
  readonly prompt: string;
  readonly answer: Record<string, unknown>;
}

export function openThread(options: ThreadOptions): Thread {
  const attempts = options.attempts ?? ANSWER_ATTEMPTS;
  const report = options.report ?? (() => undefined);
  const accepted: StoredTurn[] = [];
  let loaded: StoredTurn[] | undefined;

  return {
    path: options.path,
    async prompt(name, state = {}) {
      const file = await options.loadQuestions(name);
      const promptText = promptTextOf(file, state);
      loaded ??= await readStoredTurns(options.path);
      if (!options.turns.diverged) {
        const stored = loaded[accepted.length];
        if (stored !== undefined && stored.question === name && stored.prompt === promptText) {
          try {
            const answer = fieldsOf(file, stored.answer);
            accepted.push({ ...stored, answer });
            report(`${options.role}: ${name} replayed from ${options.path}`);
            return answer;
          } catch {
            // A stored answer the question no longer accepts is asked again, like any divergent turn.
          }
        }
      }
      options.turns.diverge();
      loaded = loaded.slice(0, accepted.length);
      await writeStoredTurns(options.path, options.role, accepted);

      let refusal: string | undefined;
      let rejected: string | undefined;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        report(`${options.role}: ${name}${attempt > 1 ? ` (attempt ${attempt} of ${attempts})` : ""}`);
        let text: string;
        try {
          options.signal?.throwIfAborted();
          text = await options.agent({
            signal: options.signal,
            prompt: (answerFile) =>
              sessionPrompt(options.preamble, accepted, file, name, promptText, answerFile, refusal, rejected),
          });
        } catch (error) {
          if (!(error instanceof AnswerMissing) || attempt === attempts) throw wrap(name, error);
          refusal = (error as Error).message;
          rejected = undefined;
          continue;
        }
        try {
          const answer = fieldsOf(file, parseAnswer(text));
          const turn: StoredTurn = { question: name, prompt: promptText, answer };
          accepted.push(turn);
          loaded = [...accepted];
          await writeStoredTurns(options.path, options.role, accepted);
          return answer;
        } catch (error) {
          refusal = (error as Error).message;
          rejected = text.length > QUOTED_ANSWER_CHARS ? `${text.slice(0, QUOTED_ANSWER_CHARS)}…` : text;
          if (attempt === attempts) {
            throw new Error(`${name}: answer rejected after ${attempts} attempts: ${refusal}`);
          }
        }
      }
      throw new Error(`${name}: no answer`);
    },
  };
}

function wrap(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error && message.startsWith(`${name}: `) ? error : new Error(`${name}: ${message}`);
}

/** The complete prompt of one session: role, the conversation so far, the question, its schema, and the answer channel. */
export function sessionPrompt(
  preamble: string,
  earlier: readonly StoredTurn[],
  file: QuestionFile,
  name: string,
  promptText: string,
  answerFile: string,
  refusal?: string,
  rejected?: string,
): string {
  const parts: string[] = [preamble.trim(), "---"];
  if (earlier.length > 0) {
    parts.push("# The conversation so far");
    earlier.forEach((turn, index) => {
      parts.push(
        `## Question ${index + 1} (${turn.question})\n\n${turn.prompt}`,
        `## Your answer ${index + 1}\n\n${JSON.stringify(turn.answer, null, 2)}`,
      );
    });
    parts.push("---");
  }
  parts.push(`# The question to answer now (${name})`, promptText);
  const field = file.fields.find((entry) => entry.name === name) ?? file.fields[0]!;
  parts.push(
    "---",
    "# How to answer",
    [
      `Do the work the question asks, using your tools. Then write your final answer as JSON to this file: ${answerFile}`,
      `The file holds one JSON object with one key per question field, here ${file.fields.map((entry) => `\`${entry.name}\``).join(", ")}, and nothing else.`,
      "The answer is validated by code against this JSON Schema; an answer that does not satisfy it is rejected.",
      "```json",
      JSON.stringify(file.wrappedSchema, null, 2),
      "```",
      "The file is the only channel: text you write in the chat is not read.",
    ].join("\n"),
  );
  if (field.examples.length > 0) {
    parts.push(
      `An example answer for \`${field.name}\` (shape only):\n\n\`\`\`json\n${JSON.stringify(field.examples[0], null, 2)}\n\`\`\``,
    );
  }
  if (refusal !== undefined) {
    parts.push(
      "---",
      `# Your previous attempt was rejected\n\n${refusal}`,
      ...(rejected === undefined ? [] : [`The answer you gave:\n\n${rejected}`]),
      "Correct the answer and write the whole corrected JSON to the answer file again. Re-check only what the rejection names.",
    );
  }
  return parts.join("\n\n");
}

async function readStoredTurns(path: string): Promise<StoredTurn[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const turns: StoredTurn[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; question?: unknown; prompt?: unknown; answer?: unknown };
      if (
        entry.type === "turn" && typeof entry.question === "string" && typeof entry.prompt === "string"
        && typeof entry.answer === "object" && entry.answer !== null && !Array.isArray(entry.answer)
      ) {
        turns.push({ question: entry.question, prompt: entry.prompt, answer: entry.answer as Record<string, unknown> });
      }
    } catch {
      // A malformed line is not a turn; the turns before and after it still count.
    }
  }
  return turns;
}

async function writeStoredTurns(path: string, role: string, turns: readonly StoredTurn[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [JSON.stringify({ type: "thread", role }), ...turns.map((turn) => JSON.stringify({ type: "turn", ...turn }))];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
