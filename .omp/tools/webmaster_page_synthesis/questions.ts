import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The prompt files next to a tool: a questions YAML file holds decision questions (an entry with `criteria`) and
 * language questions (an entry with `schema`), by field. Parsed with Bun's built-in YAML parser. The text of each
 * instruction is the Mastra capability's, unchanged; what differs is how it reaches a model (one `omp -p` completion
 * that answers in JSON, see `omp_model.ts`).
 */

export type QuestionKind = "noul" | "choice" | "score";

/** One question with fixed answers: a yes/no, a pick among named options, or a level on an ordered scale. */
export interface DecisionQuestion {
  readonly field: string;
  readonly kind: QuestionKind;
  readonly instructions: string;
  /** noul: {true,false}; choice: {option: meaning}; score: one string per level, lowest first. */
  readonly criteria: Readonly<Record<string, string>> | readonly string[];
}

/** One question whose answer is free JSON under `field`. */
export interface LanguageQuestion {
  readonly field: string;
  readonly instructions: string;
  /** Each example as the words a model is shown. */
  readonly examples: readonly string[];
  /** JSON Schema of the value under `field` in the reply. */
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface QuestionFile {
  readonly decisions: readonly DecisionQuestion[];
  readonly language: Readonly<Record<string, LanguageQuestion>>;
}

interface RawLevel {
  readonly what: string;
  readonly examples?: readonly string[];
}

interface RawEntry {
  readonly type?: QuestionKind;
  readonly instructions: string;
  readonly criteria?: Readonly<Record<string, string>> | readonly RawLevel[];
  readonly examples?: readonly unknown[];
  readonly schema?: Readonly<Record<string, unknown>>;
}

const levelText = (level: RawLevel): string =>
  `${level.what.trim()}${(level.examples ?? []).map((example) => ` Example: ${example}`).join("")}`;

const isYesNo = (criteria: Record<string, string>): boolean => {
  const keys = Object.keys(criteria).sort();
  return keys.length === 2 && keys[0] === "false" && keys[1] === "true";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An example as a model is shown it: text as written; a prompt-and-answer pair as the two labelled; anything else as JSON. */
function exampleText(example: unknown): string {
  if (typeof example === "string") return example.trim();
  if (isRecord(example) && typeof example["prompt"] === "string" && "answer" in example) {
    return `Prompt:\n${example["prompt"].trim()}\nAnswer:\n${JSON.stringify(example["answer"], null, 2)}`;
  }
  return JSON.stringify(example, null, 2);
}

/** Reads the text of a questions YAML file. `label` names the file in errors. */
export function parseQuestionFile(text: string, label: string): QuestionFile {
  const document: unknown = Bun.YAML.parse(text);
  if (!isRecord(document)) throw new Error(`${label}: expected a mapping of questions`);
  const keys = Object.keys(document);
  const wrapped = document["questions"];
  const entries = (keys.length === 1 && keys[0] === "questions" && isRecord(wrapped) ? wrapped : document) as Record<
    string,
    RawEntry
  >;
  const decisions: DecisionQuestion[] = [];
  const language: Record<string, LanguageQuestion> = {};
  for (const [field, entry] of Object.entries(entries)) {
    if (entry.criteria !== undefined) {
      const instructions = entry.instructions.trim();
      if (Array.isArray(entry.criteria)) {
        decisions.push({ field, kind: "score", instructions, criteria: (entry.criteria as RawLevel[]).map(levelText) });
      } else {
        const criteria = entry.criteria as Record<string, string>;
        decisions.push({ field, kind: isYesNo(criteria) ? "noul" : "choice", instructions, criteria });
      }
    } else if (entry.schema !== undefined) {
      language[field] = {
        field,
        instructions: entry.instructions.trim(),
        examples: (entry.examples ?? []).map(exampleText),
        schema: entry.schema,
      };
    } else {
      throw new Error(`${label}: question ${field} has neither criteria (decision) nor schema (language)`);
    }
  }
  return { decisions, language };
}

/** Reads a questions YAML file from disk next to the tool. */
export function loadQuestionFile(location: URL | string): QuestionFile {
  const file = location instanceof URL ? fileURLToPath(location) : location;
  return parseQuestionFile(readFileSync(file, "utf8"), file);
}

export const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

/** The JSON Schema of a reply: an object whose one required key is the question's field. */
export function replySchemaOf(question: LanguageQuestion): Record<string, unknown> {
  return {
    type: "object",
    properties: { [question.field]: question.schema },
    required: [question.field],
    additionalProperties: false,
  };
}

/** What a model reads for one language question: instructions, examples, the input, then the reply schema. */
export function languagePrompt(question: LanguageQuestion, input: string): string {
  const examples = question.examples.map((example) => `Example:\n${example}\n`).join("");
  const text = `## ${question.field}\n${question.instructions}\n${examples}\nPrompt:\n${input}\n`;
  return `${text}${SCHEMA_LEAD}${JSON.stringify(replySchemaOf(question))}\nAnswer with only that JSON object, no prose and no code fence.`;
}

/** The criteria of a decision question as the lines a model reads under its instructions. */
export function criteriaLines(question: DecisionQuestion): string[] {
  if (Array.isArray(question.criteria)) {
    return (question.criteria as readonly string[]).map((level, index) => `${index}: ${level}`);
  }
  return Object.entries(question.criteria as Record<string, string>).map(([option, meaning]) => `${option}: ${meaning}`);
}
