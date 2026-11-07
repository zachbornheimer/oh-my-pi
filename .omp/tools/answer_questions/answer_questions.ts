import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type DecisionAnswer, decide } from "./decide.js";
import { answerLanguage, checkable } from "./language.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { type LanguageQuestion, parseQuestionFile, type Question } from "./questions.js";
import type { RecentTurns } from "./recent_turns.js";

/** How the decision step is shown a string state. */
export const STATE_LEAD = "The state the questions are about:";
/** How the decision step is shown the extra material: the next proposed tool call, a diff, a rule. */
export const CONTEXT_LEAD = "Additional context to judge by:";

export const BLANK_STATE_MESSAGE = "state is required: a blank string asks nothing";
export const NO_STATE_MESSAGE =
  "neither state nor conversation was given: pass state, or a conversation to read the newest turns of";

/** Defaults of the conversation reader, as `get_recent_turns` has them. */
export const DEFAULT_TURNS = 16;
export const DEFAULT_LENGTH_LIMIT = 3_000;
export const DEFAULT_MAX_TOKENS = 12_000;
/** Most model calls (decision, language) in flight at once. */
const MODEL_CONCURRENCY = 4;

export interface AnswerQuestionsInput {
  state?: string | Record<string, unknown>;
  conversation?: string;
  additional_context?: string | Record<string, unknown>;
  turns?: number;
  length_limit?: number;
  max_tokens?: number;
  questions: { file: string }[];
}

export interface TurnsUsed {
  total_turns: number;
  kept: number;
  dropped: number;
}

export interface AnswerQuestionsOutput {
  answers: Record<string, unknown>;
  conversation?: string;
  turns?: TurnsUsed;
}

export interface Deps {
  step: ModelStep;
  /** Reads a `<harness>:<id>` conversation and selects its newest turns. */
  readConversation: (
    reference: string,
    bounds: { turns: number; lengthLimit: number; maxTokens: number },
    signal?: AbortSignal,
  ) => Promise<RecentTurns>;
  signal?: AbortSignal;
}

/** A refused input: reads as `invalid input for answer_questions: <cause>`. */
export class InputError extends Error {
  constructor(cause: string) {
    super(`invalid input for answer_questions: ${cause}`);
    this.name = "InputError";
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface View {
  readonly decision: unknown;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateView(state: string | Record<string, unknown>): View {
  if (typeof state === "string") {
    const text = state.trim();
    if (text === "") throw new InputError(`state: ${BLANK_STATE_MESSAGE}`);
    return { decision: { [STATE_LEAD]: text }, text };
  }
  if (!isRecord(state)) throw new InputError("state: must be a non-blank string or a JSON object");
  return { decision: state, text: JSON.stringify(state, null, 2) };
}

function contextView(context: string | Record<string, unknown>): View {
  if (typeof context === "string") {
    const text = context.trim();
    return { decision: text, text };
  }
  return { decision: context, text: JSON.stringify(context, null, 2) };
}

/** The state with any additional context appended under its own heading. */
function withContext(base: View, context: string | Record<string, unknown> | undefined): View {
  if (context === undefined) return base;
  const view = contextView(context);
  const decision = isRecord(base.decision)
    ? { ...base.decision, [CONTEXT_LEAD]: view.decision }
    : { [STATE_LEAD]: base.text, [CONTEXT_LEAD]: view.decision };
  return { decision, text: `${base.text}\n\n${CONTEXT_LEAD}\n${view.text}` };
}

interface ResolvedState extends View {
  conversation?: string;
  turns?: TurnsUsed;
}

async function resolveState(input: AnswerQuestionsInput, deps: Deps): Promise<ResolvedState> {
  if (input.state !== undefined) return withContext(stateView(input.state), input.additional_context);
  if (input.conversation === undefined) throw new InputError(`state: ${NO_STATE_MESSAGE}`);
  let recent: RecentTurns;
  try {
    recent = await deps.readConversation(
      input.conversation,
      {
        turns: input.turns ?? DEFAULT_TURNS,
        lengthLimit: input.length_limit ?? DEFAULT_LENGTH_LIMIT,
        maxTokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
      },
      deps.signal,
    );
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    throw new Error(`cannot read conversation ${input.conversation}: ${messageOf(error)}`);
  }
  const base: View = { decision: { [STATE_LEAD]: recent.text }, text: recent.text };
  return {
    ...withContext(base, input.additional_context),
    conversation: recent.conversation,
    turns: {
      total_turns: recent.totalTurns,
      kept: recent.turns.length,
      dropped: Math.max(0, recent.totalTurns - recent.turns.length),
    },
  };
}

/** Reads one file by exactly the path given; no fallback search, so a missing file can never become another file. */
function readQuestionFile(file: string) {
  if (!existsSync(file)) throw new Error(`question file not found: ${file}`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`question file ${file}: ${messageOf(error)}`);
  }
  try {
    return parseQuestionFile(text, file);
  } catch (error) {
    const why = messageOf(error);
    throw new Error(why.includes(file) ? why : `question file ${file}: ${why}`);
  }
}

interface QuestionSet {
  decisions: Question[];
  language: LanguageQuestion[];
}

/** Loads every file before any model is asked, so a bad path or a clashing field costs no call. */
function loadQuestions(files: readonly string[]): QuestionSet {
  const owner = new Map<string, string>();
  const claim = (field: string, file: string) => {
    const first = owner.get(field);
    if (first !== undefined) throw new Error(`question field ${field} appears in both ${first} and ${file}`);
    owner.set(field, file);
  };
  const set: QuestionSet = { decisions: [], language: [] };
  for (const file of files) {
    const loaded = readQuestionFile(file);
    for (const question of loaded.decisions) {
      claim(question.field, file);
      set.decisions.push(question);
    }
    for (const question of Object.values(loaded.language)) {
      claim(question.field, file);
      try {
        checkable(question);
      } catch (error) {
        throw new Error(`question file ${file}: ${messageOf(error)}`);
      }
      set.language.push(question);
    }
  }
  return set;
}

function validateInput(input: AnswerQuestionsInput): void {
  if (input.questions.length === 0) throw new InputError("questions: at least one question file is required");
  for (const item of input.questions) {
    if (!isAbsolute(item.file)) {
      throw new InputError(`questions: question file must be an absolute path, got ${JSON.stringify(item.file)}`);
    }
  }
  for (const [name, value] of [["turns", input.turns], ["length_limit", input.length_limit], ["max_tokens", input.max_tokens]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new InputError(`${name}: must be a positive integer`);
  }
}

/**
 * Answers every question in the named files about one state. The state is `state`, else the newest turns of
 * `conversation`, either way followed by `additional_context`. All files load before any model runs. One decision call
 * answers every decision question; each language question is one call; they run concurrently and the first failure
 * aborts the rest. Nothing is guessed: any failure throws.
 */
export async function answerQuestions(input: AnswerQuestionsInput, deps: Deps): Promise<AnswerQuestionsOutput> {
  validateInput(input);
  const state = await resolveState(input, deps);
  let questions: QuestionSet;
  try {
    questions = loadQuestions(input.questions.map((item) => item.file));
  } catch (error) {
    throw new Error(`answer questions: ${messageOf(error)}`);
  }
  const abort = new AbortController();
  const signal = deps.signal === undefined ? abort.signal : AbortSignal.any([deps.signal, abort.signal]);
  const jobs: (() => Promise<[string, unknown][]>)[] = [];
  if (questions.decisions.length > 0) {
    jobs.push(async () => {
      const answers: Record<string, DecisionAnswer> = await decide(deps.step, state.decision, questions.decisions, signal);
      return Object.entries(answers);
    });
  }
  for (const question of questions.language) {
    jobs.push(async () => [[question.field, await answerLanguage(deps.step, question, state.text, signal)]]);
  }
  let settled: [string, unknown][][];
  try {
    settled = await mapLimit(jobs, MODEL_CONCURRENCY, (job) => job());
  } catch (error) {
    abort.abort();
    if (deps.signal?.aborted) throw error;
    throw new Error(`answer questions: ${messageOf(error)}`);
  }
  const output: AnswerQuestionsOutput = { answers: Object.fromEntries(settled.flat()) };
  if (state.conversation !== undefined) output.conversation = state.conversation;
  if (state.turns !== undefined) output.turns = state.turns;
  return output;
}
