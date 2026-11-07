/**
 * The assessment questions a tool asks of one piece of text, and how a model's JSON reply to all of them is checked.
 *
 * Mastra asked these as TypeSafe Jev `decide` questions: a choice, a P(yes) or a score, each answered with
 * calibrated probabilities. Here one model call states one answer per question: the chosen option, a yes/no, or the
 * level; nothing is guessed from prose, and a reply that is missing a question or names an unknown option is refused.
 */

export interface ChoiceQuestion {
  readonly field: string;
  readonly kind: "choice";
  readonly instructions: string;
  /** option -> what it means, in the order the options are listed. */
  readonly options: Readonly<Record<string, string>>;
}

export interface YesNoQuestion {
  readonly field: string;
  readonly kind: "yesno";
  readonly instructions: string;
  readonly yes: string;
  readonly no: string;
}

export interface ScoreQuestion {
  readonly field: string;
  readonly kind: "score";
  readonly instructions: string;
  /** Lowest level first; the answer is the index. */
  readonly levels: readonly { readonly name: string; readonly what: string; readonly examples?: readonly string[] }[];
}

export type Question = ChoiceQuestion | YesNoQuestion | ScoreQuestion;

/** What a model stated for one question. */
export type Answer = { Value: string } | { Point: number; Value: string } | boolean;

export const SUBJECT_LEAD = "Answer about this segment only:";
export const CONTEXT_LEAD = "The whole input, for context only (do not answer about other segments):";

function questionText(question: Question): string {
  const head = `## ${question.field}\n${question.instructions}`;
  switch (question.kind) {
    case "choice":
      return `${head}\nOptions (reply with exactly one option name):\n${
        Object.entries(question.options).map(([name, meaning]) => `- ${name}: ${meaning}`).join("\n")
      }`;
    case "yesno":
      return `${head}\nReply true or false.\n- true: ${question.yes}\n- false: ${question.no}`;
    case "score":
      return `${head}\nLevels, lowest first (reply with the level's number):\n${
        question.levels.map((level, index) => {
          const examples = (level.examples ?? []).map((example) => `\n     e.g. ${example}`).join("");
          return `  ${index} (${level.name}): ${level.what}${examples}`;
        }).join("\n")
      }`;
  }
}

function replyShape(question: Question): string {
  switch (question.kind) {
    case "choice":
      return `"${question.field}": "${Object.keys(question.options).join(" | ")}"`;
    case "yesno":
      return `"${question.field}": true | false`;
    case "score":
      return `"${question.field}": ${question.levels.map((_level, index) => index).join(" | ")}`;
  }
}

/** The whole assessment prompt: every question, the focus text, the whole input as context only, and the reply shape. */
export function decisionPrompt(intro: string, questions: readonly Question[], focus: string, whole: string): string {
  const state = [`${SUBJECT_LEAD}\n${focus}`];
  if (whole !== "" && whole !== focus) state.push(`${CONTEXT_LEAD}\n${whole}`);
  return [
    intro,
    "",
    ...questions.flatMap((question) => [questionText(question), ""]),
    ...state.flatMap((block) => [block, ""]),
    "Reply with only a JSON object that answers every question above.",
    `Respond as JSON matching this shape: {${questions.map(replyShape).join(", ")}}`,
  ].join("\n");
}

/** The answers a reply states; throws, naming the first question that is missing or answered off its options. */
export function parseDecisions(questions: readonly Question[], value: unknown): Record<string, Answer> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the reply must be a JSON object with one answer per question");
  }
  const reply = value as Record<string, unknown>;
  const answers: Record<string, Answer> = {};
  for (const question of questions) {
    const given = reply[question.field];
    switch (question.kind) {
      case "choice": {
        const options = Object.keys(question.options);
        if (typeof given !== "string" || !options.includes(given.trim())) {
          throw new Error(`${question.field} must be one of ${options.join(", ")}, got ${JSON.stringify(given)}`);
        }
        answers[question.field] = { Value: given.trim() };
        break;
      }
      case "yesno":
        if (typeof given !== "boolean") {
          throw new Error(`${question.field} must be true or false, got ${JSON.stringify(given)}`);
        }
        answers[question.field] = given;
        break;
      case "score": {
        if (typeof given !== "number" || !Number.isInteger(given) || given < 0 || given >= question.levels.length) {
          throw new Error(`${question.field} must be an integer level from 0 to ${question.levels.length - 1}, got ${JSON.stringify(given)}`);
        }
        answers[question.field] = { Point: given, Value: question.levels[given]!.name };
        break;
      }
    }
  }
  return answers;
}
