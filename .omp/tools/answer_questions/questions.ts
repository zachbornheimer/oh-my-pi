/**
 * Question files in the ai-question-schema format, parsed with Bun's YAML parser (the same parser omp itself uses).
 * An entry with `criteria` is a decision question (yes/no, choice or score); an entry with `schema` is a language
 * question. Questions may sit at the top level or under one `questions:` key. Copied, not imported, into every tool
 * directory that reads question files.
 */

export type QuestionKind = "noul" | "choice" | "score";

/** One question for the decision step, in file order. */
export interface Question {
  readonly field: string;
  readonly kind: QuestionKind;
  readonly instructions: string;
  /** noul: {true,false}; choice: {option: meaning}; score: one string per level, lowest first. */
  readonly criteria: Readonly<Record<string, string>> | readonly string[];
}

/** One question for the language step: words in, one JSON value out. */
export interface LanguageQuestion {
  readonly field: string;
  readonly instructions: string;
  /** Each example as the words a model is shown. */
  readonly examples: readonly string[];
  /** JSON Schema of the value under `field` in the reply. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/** A question file: its decision questions in order, its language questions by field. */
export interface QuestionFile {
  readonly decisions: readonly Question[];
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

function levelText(level: RawLevel): string {
  const examples = (level.examples ?? []).map((example) => ` Example: ${example}`).join("");
  return `${String(level.what).trim()}${examples}`;
}

function isYesNo(criteria: Record<string, unknown>): boolean {
  const keys = Object.keys(criteria).sort();
  return keys.length === 2 && keys[0] === "false" && keys[1] === "true";
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function toDecision(field: string, raw: RawEntry & { criteria: NonNullable<RawEntry["criteria"]> }): Question {
  if (typeof raw.instructions !== "string" || raw.instructions.trim() === "") {
    throw new Error(`question ${field} has no instructions`);
  }
  const instructions = raw.instructions.trim();
  if (Array.isArray(raw.criteria)) {
    if (raw.criteria.length < 1) throw new Error(`question ${field}: a score question needs at least one level`);
    return { field, kind: "score", instructions, criteria: (raw.criteria as RawLevel[]).map(levelText) };
  }
  if (typeof raw.criteria !== "object" || raw.criteria === null) {
    throw new Error(`question ${field}: criteria must be a map or a list`);
  }
  const entries = Object.entries(raw.criteria as Record<string, unknown>);
  if (entries.length < 1) throw new Error(`question ${field}: a choice question needs at least one option`);
  const criteria = Object.fromEntries(entries.map(([key, value]) => [key, textOf(value)]));
  return { field, kind: isYesNo(criteria) ? "noul" : "choice", instructions, criteria };
}

/** `value` with every map's keys in sorted order, so an example always renders the same way. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]),
  );
}

/** An example as a model is shown it: text as written, anything structured as its YAML (keys sorted, 4-space indent). */
function exampleText(example: unknown): string {
  if (typeof example === "string") return example.trim();
  return String(Bun.YAML.stringify(sorted(example), null, 4)).trim();
}

function toLanguage(field: string, raw: RawEntry & { schema: NonNullable<RawEntry["schema"]> }): LanguageQuestion {
  if (typeof raw.instructions !== "string" || raw.instructions.trim() === "") {
    throw new Error(`question ${field} has no instructions`);
  }
  if (typeof raw.schema !== "object" || raw.schema === null || Array.isArray(raw.schema)) {
    throw new Error(`question ${field}: schema must be a JSON Schema object`);
  }
  return {
    field,
    instructions: raw.instructions.trim(),
    examples: (raw.examples ?? []).map(exampleText),
    schema: raw.schema,
  };
}

const WRAPPER_KEY = "questions";

/** The question entries of a parsed document: a lone top-level `questions` map is unwrapped. */
function entriesOf(document: unknown, label: string): Record<string, RawEntry> {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${label}: the file must be a map of questions`);
  }
  const record = document as Record<string, unknown>;
  const keys = Object.keys(record);
  const wrapped = record[WRAPPER_KEY];
  const isWrapper = keys.length === 1 && keys[0] === WRAPPER_KEY && typeof wrapped === "object" && wrapped !== null
    && !Array.isArray(wrapped);
  return (isWrapper ? wrapped : record) as Record<string, RawEntry>;
}

/**
 * Parses the text of a question file. `label` names the file in errors. A decision question's optional `type` must
 * match what its criteria make it. An empty file or a file with an entry that is neither kind fails.
 */
export function parseQuestionFile(text: string, label: string): QuestionFile {
  let document: unknown;
  try {
    document = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid YAML: ${(error as Error).message}`);
  }
  const raw = entriesOf(document, label);
  const decisions: Question[] = [];
  const language: Record<string, LanguageQuestion> = {};
  for (const [field, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${label}: question ${field} is not a map`);
    }
    try {
      if (entry.criteria !== undefined) {
        const decision = toDecision(field, { ...entry, criteria: entry.criteria });
        if (entry.type !== undefined && entry.type !== decision.kind) {
          throw new Error(`question ${field} says type ${entry.type} but its criteria make it a ${decision.kind} question`);
        }
        decisions.push(decision);
      } else if (entry.schema !== undefined) {
        language[field] = toLanguage(field, { ...entry, schema: entry.schema });
      } else {
        throw new Error(`question ${field} has neither criteria (decision) nor schema (language)`);
      }
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
  }
  if (decisions.length === 0 && Object.keys(language).length === 0) throw new Error(`${label}: the file holds no questions`);
  return { decisions, language };
}
