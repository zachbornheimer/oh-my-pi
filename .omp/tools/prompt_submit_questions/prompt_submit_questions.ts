import { readFileSync } from "node:fs";
import { type DecisionAnswer, decide } from "./decide.js";
import { answerLanguage, checkable } from "./language.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { type LanguageQuestion, parseQuestionFile, type Question, type QuestionFile } from "./questions.js";

/**
 * Approximate maximum question characters per decision call. The shared state is sent with every call, so question
 * text stays well below the model's context window.
 */
export const REQUEST_CHARS_MAX = 48_000;
/** Most model calls (decision batches, language questions) in flight at once. */
const MODEL_CONCURRENCY = 4;
/** The bundled question files a `{file}` source may name. */
export const BUNDLED_FILES = ["prompt_answers", "dictation"] as const;

export type FileSource = { file: string };
export type InlineDecisionSource = { id: string; question: string; choices: Record<string, string> };
export type InlineLanguageSource = {
  id: string;
  kind: "language";
  question: string;
  schema: Record<string, unknown>;
  examples?: string[];
};
export type QuestionSource = FileSource | InlineDecisionSource | InlineLanguageSource;

/** One question as the tool receives it: a flat object, because omp's schema builder cannot union objects. */
export interface RawQuestion {
  file?: string | null;
  id?: string | null;
  kind?: string | null;
  question?: string | null;
  choices?: Record<string, string> | null;
  schema?: Record<string, unknown> | null;
  examples?: string[] | null;
}

/**
 * Sorts each raw question into its source form: `file` makes a file source; `kind: "language"` a language question
 * (`id`, `question`, `schema` required); otherwise a decision (`id`, `question`, `choices` required). A question that
 * fits none, or mixes `file` with other fields, is refused naming its position.
 */
export function toSources(items: readonly RawQuestion[]): QuestionSource[] {
  return items.map((item, index): QuestionSource => {
    const at = `questions[${index}]`;
    const present = (key: keyof RawQuestion): boolean => item[key] !== undefined && item[key] !== null;
    if (present("file")) {
      const extra = (["id", "kind", "question", "choices", "schema", "examples"] as const).filter(present);
      if (extra.length > 0) throw new Error(`${at}: a file source takes only \`file\`, also got ${extra.join(", ")}`);
      return { file: item.file! };
    }
    for (const key of ["id", "question"] as const) {
      if (!present(key) || item[key] === "") throw new Error(`${at}: \`${key}\` is required`);
    }
    if (item.kind === "language") {
      if (!present("schema")) throw new Error(`${at}: a language question needs \`schema\``);
      if (present("choices")) throw new Error(`${at}: a language question takes \`schema\`, not \`choices\``);
      return {
        id: item.id!,
        kind: "language",
        question: item.question!,
        schema: item.schema!,
        ...(present("examples") ? { examples: item.examples! } : {}),
      };
    }
    if (present("kind")) throw new Error(`${at}: \`kind\` must be "language" or omitted, got ${JSON.stringify(item.kind)}`);
    if (!present("choices")) throw new Error(`${at}: a decision question needs \`choices\` (or give \`file\`, or kind "language" with \`schema\`)`);
    if (present("schema") || present("examples")) throw new Error(`${at}: \`schema\` and \`examples\` belong to kind "language"`);
    return { id: item.id!, question: item.question!, choices: item.choices! };
  });
}

export interface PromptSubmitInput {
  state: unknown;
  questions: QuestionSource[];
}

export interface PromptSubmitOutput {
  answers: Record<string, unknown>;
}

export interface Expanded {
  decisions: Question[];
  language: LanguageQuestion[];
}

const BOOLEAN_CRITERIA = { false: "", true: "" } as const;

/** Reads a bundled question file from beside this module. */
function bundled(name: string): QuestionFile {
  const file = new URL(`./${name}.yaml`, import.meta.url);
  return parseQuestionFile(readFileSync(file, "utf8"), file.pathname);
}

/**
 * Turns the question sources into decision and language questions, in source order. Duplicate ids, an unknown file,
 * an empty `choices` map and a schema the checker cannot enforce fail here, before any model is asked.
 */
export function expandQuestions(
  sources: readonly QuestionSource[],
  files: (name: string) => QuestionFile = bundled,
): Expanded {
  const decisions: Question[] = [];
  const language: LanguageQuestion[] = [];
  const fields = new Set<string>();
  const addField = (field: string): void => {
    if (field === "") throw new Error("a question id must not be empty");
    if (fields.has(field)) throw new Error(`question field "${field}" is declared more than once`);
    fields.add(field);
  };
  const addLanguage = (question: LanguageQuestion): void => {
    checkable(question);
    language.push(question);
  };

  for (const source of sources) {
    if ("file" in source) {
      if (!(BUNDLED_FILES as readonly string[]).includes(source.file)) {
        throw new Error(`unknown question file "${source.file}"; the bundled files are ${BUNDLED_FILES.join(", ")}`);
      }
      const file = files(source.file);
      for (const question of file.decisions) {
        addField(question.field);
        decisions.push(question);
      }
      for (const question of Object.values(file.language)) {
        addField(question.field);
        addLanguage(question);
      }
    } else if ("schema" in source) {
      addField(source.id);
      addLanguage({
        field: source.id,
        instructions: source.question,
        examples: source.examples ?? [],
        schema: source.schema,
      });
    } else {
      addField(source.id);
      const keys = Object.keys(source.choices);
      if (keys.length === 0) throw new Error(`question "${source.id}" has no choices`);
      const isYesNo = keys.length === 2 && keys.slice().sort().join(",") === "false,true";
      decisions.push({
        field: source.id,
        kind: isYesNo ? "noul" : "choice",
        instructions: source.question,
        criteria: isYesNo ? BOOLEAN_CRITERIA : source.choices,
      });
    }
  }
  return { decisions, language };
}

/** Approximate serialized size of one decision question, including its criteria and their labels. */
export function decisionQuestionSize(question: Question): number {
  let size = question.field.length + question.kind.length + question.instructions.length;
  if (Array.isArray(question.criteria)) {
    for (const criterion of question.criteria as readonly string[]) size += criterion.length;
    return size;
  }
  for (const [key, value] of Object.entries(question.criteria as Record<string, string>)) size += key.length + value.length;
  return size;
}

/** Items in order, split greedily by size; an oversized item goes alone. */
export function batchesOf<T>(items: readonly T[], sizeOf: (item: T) => number, maxChars: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && chars + size > maxChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function languageText(state: unknown): string {
  return typeof state === "string" ? state : (JSON.stringify(state, null, 2) ?? String(state));
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Answers every question about `state` and returns one map keyed by question id. Decision questions are split by size
 * into batches; batches and language questions run concurrently (up to four model processes), and the first failure
 * aborts the rest and fails the call. Nothing is guessed.
 */
export async function promptSubmitQuestions(
  input: PromptSubmitInput,
  step: ModelStep,
  signal?: AbortSignal,
  files?: (name: string) => QuestionFile,
): Promise<PromptSubmitOutput> {
  if (input.state === undefined) throw new Error("state is required: pass the prompt context (a string or JSON)");
  if (input.questions.length === 0) throw new Error("questions: at least one question is required");
  const expanded = expandQuestions(input.questions, files);
  const batches = batchesOf(expanded.decisions, decisionQuestionSize, REQUEST_CHARS_MAX);
  const text = languageText(input.state);

  const abort = new AbortController();
  const linked = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal]);
  const jobs: (() => Promise<[string, unknown][]>)[] = [
    ...batches.map((batch) => async () => {
      const answers: Record<string, DecisionAnswer> = await decide(step, input.state, batch, linked);
      return Object.entries(answers);
    }),
    ...expanded.language.map((question) => async (): Promise<[string, unknown][]> => [
      [question.field, await answerLanguage(step, question, text, linked)],
    ]),
  ];
  try {
    const settled = await mapLimit(jobs, MODEL_CONCURRENCY, (job) => job());
    return { answers: Object.fromEntries(settled.flat()) };
  } catch (error) {
    abort.abort();
    if (signal?.aborted) throw error;
    throw new Error(`prompt_submit_questions: ${messageOf(error)}`);
  }
}
