import { readFileSync } from "node:fs";

/** The prompt text and reply schema, copied from the Mastra capability's `questions/summarize.yaml` (`summarize.yaml` beside this file). */
interface QuestionFile {
  Summary: { instructions: string; schema: Record<string, unknown> };
}

let loaded: QuestionFile["Summary"] | undefined;

/** The question, read once from `summarize.yaml`; a missing or malformed file throws. */
export function summaryQuestion(): QuestionFile["Summary"] {
  if (loaded !== undefined) return loaded;
  const doc = Bun.YAML.parse(readFileSync(new URL("./summarize.yaml", import.meta.url), "utf8")) as Partial<QuestionFile> | null;
  const question = doc?.Summary;
  if (!question || typeof question.instructions !== "string" || question.instructions.trim() === "" || typeof question.schema !== "object" || question.schema === null) {
    throw new Error("summarize.yaml: expected a Summary question with instructions and a schema");
  }
  loaded = question;
  return question;
}

export const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

export interface FocusAnswer {
  question: string;
  answer: string;
  relevant_data: string;
}

export interface SummaryReply {
  summary: string;
  focus: FocusAnswer[];
}

/** What the model reads: the instructions, the argument label, the focus questions, the source text, then the reply schema. */
export function summaryPrompt(argument: string, focus: readonly string[], text: string): string {
  const question = summaryQuestion();
  const asked = focus.length === 0 ? "" : `Focus:\n${focus.map((entry) => `- ${entry}`).join("\n")}\n\n`;
  return `## Summary\n${question.instructions}\n\nPrompt:\nArgument: ${argument}\n\n${asked}${text}\n${SCHEMA_LEAD}${JSON.stringify(question.schema)}\n\nReply with only the JSON object.`;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function nonBlank(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

/**
 * Validates a model reply against the schema and the capability's rules; throws to reject (the model is asked again with
 * the reason). Answers to questions nobody asked are dropped, not refused: they cost a second model call for a field the
 * caller never wanted.
 */
export function acceptSummary(value: unknown, asked: readonly string[], rawPath: string): SummaryReply {
  if (!isObject(value)) throw new Error("the reply must be a JSON object with summary and focus");
  const summary = nonBlank(value.summary, "summary");
  if (summary.includes(rawPath)) throw new Error("do not put the raw output path in the summary");
  if (!Array.isArray(value.focus)) throw new Error("focus must be an array");
  if (asked.length === 0) return { summary, focus: [] };
  const focus = value.focus.map((entry, index): FocusAnswer => {
    if (!isObject(entry)) throw new Error(`focus[${index}] must be an object`);
    return {
      question: nonBlank(entry.question, `focus[${index}].question`),
      answer: nonBlank(entry.answer, `focus[${index}].answer`),
      relevant_data: nonBlank(entry.relevant_data, `focus[${index}].relevant_data`),
    };
  });
  if (focus.length !== asked.length) throw new Error(`focus must answer each question in order: asked ${asked.length}, got ${focus.length}`);
  for (const [index, question] of asked.entries()) {
    const answered = focus[index]!.question;
    if (answered !== question) {
      throw new Error(`focus question ${index + 1} must be exactly ${JSON.stringify(question)}, got ${JSON.stringify(answered)}`);
    }
  }
  return { summary, focus };
}
