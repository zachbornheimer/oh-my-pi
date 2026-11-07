/**
 * Question files in the ai-question-schema format, ported from `@zab-ai/ai`'s `questions.ts` and parsed with Bun's YAML
 * parser (the parser omp itself uses). Every top-level key is one result field: its `instructions` are rendered from the
 * caller's state (`{key}` is replaced) and its `schema` decides how the answer is validated, in code. The learn chain's
 * four files carry language questions only, so a `criteria` (decision) entry is refused by name rather than half-handled.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A JSON Schema as question files carry them: the shapes the ai-question-schema vocabulary allows. */
export type JsonSchema = Record<string, unknown>;

/** One result field of a question file: its raw instructions, the schema of the value it yields and its examples. */
export interface QuestionField {
  readonly name: string;
  readonly instructions: string;
  readonly schema: JsonSchema;
  /** The `answer` of each example the file shows, when it has any. */
  readonly examples: readonly unknown[];
}

export interface QuestionFile {
  /** The file's schema fields, in file order. */
  readonly fields: readonly QuestionField[];
  /** One object carrying every field: what an answer to the whole file must satisfy. */
  readonly wrappedSchema: JsonSchema;
}

interface RawField {
  readonly instructions?: unknown;
  readonly schema?: unknown;
  readonly criteria?: unknown;
  readonly examples?: unknown;
}

/** Where the question files sit: `prompts/` next to this module. */
export const PROMPTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** Loads `prompts/<name>.yaml`. */
export async function loadQuestionFile(name: string, directory: string = PROMPTS_DIRECTORY): Promise<QuestionFile> {
  const path = join(directory, `${name}.yaml`);
  return parseQuestionFile(name, await readFile(path, "utf8"));
}

/** Parses question-file text; every malformed shape throws with the file named. */
export function parseQuestionFile(label: string, text: string): QuestionFile {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid YAML: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} did not parse to a question map`);
  }
  const fields = Object.entries(parsed as Record<string, RawField>).map(([name, raw]) => fieldOf(label, name, raw));
  if (fields.length === 0) throw new Error(`${label} holds no question fields`);
  return {
    fields,
    wrappedSchema: {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field.name, field.schema])),
      required: fields.map((field) => field.name),
      additionalProperties: false,
    },
  };
}

function fieldOf(label: string, name: string, raw: RawField): QuestionField {
  if (!/^[A-Z]/.test(name)) throw new Error(`${label}: field ${name} must start with a capital letter`);
  if (typeof raw !== "object" || raw === null) throw new Error(`${label}: ${name} is not a question`);
  if (typeof raw.instructions !== "string" || raw.instructions.trim() === "") {
    throw new Error(`${label}: ${name} needs non-empty instructions`);
  }
  if (raw.criteria !== undefined) {
    throw new Error(`${label}: ${name} is a criteria (decision) question; this tool answers language questions only`);
  }
  const schema = raw.schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${label}: ${name} needs a schema`);
  }
  const record = schema as JsonSchema;
  if (record.type === "string" && record.minLength === undefined && record.enum === undefined && record.maxLength === undefined) {
    throw new Error(`${label}: ${name} is unconstrained prose (schema: {type: string}), not an answer`);
  }
  const examples = Array.isArray(raw.examples)
    ? raw.examples.flatMap((example) => {
        const answer = (example as { answer?: unknown } | null)?.answer;
        return answer === undefined ? [] : [answer];
      })
    : [];
  return { name, instructions: raw.instructions, schema: record, examples };
}

/** Renders `state` into instructions: `{key}` becomes the state value, deterministically. */
export function renderInstructions(instructions: string, state: Readonly<Record<string, unknown>>): string {
  let rendered = instructions;
  for (const [key, value] of Object.entries(state)) {
    rendered = rendered.replaceAll(`{${key}}`, () => String(value ?? ""));
  }
  return rendered;
}

/** The rendered prompt of a whole question file: every field's instructions, in file order. A state key nothing renders is refused. */
export function promptTextOf(file: QuestionFile, state: Readonly<Record<string, unknown>>): string {
  for (const key of Object.keys(state)) {
    if (!file.fields.some((field) => field.instructions.includes(`{${key}}`))) {
      throw new Error(`question file has no {${key}} to render`);
    }
  }
  return file.fields.map((field) => renderInstructions(field.instructions, state)).join("\n\n");
}

/** The fields an answer carries, each validated against its schema; a violation is named and thrown. */
export function fieldsOf(file: QuestionFile, data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("the answer is not an object of the question file's fields");
  }
  const record = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of file.fields) {
    const violations = schemaViolations(record[field.name], field.schema, field.name);
    if (violations.length > 0) throw new Error(`answer rejected: ${violations.join("; ")}`);
    out[field.name] = record[field.name];
  }
  return out;
}

/** The schema violations of one value, empty when it conforms. Covers the ai-question-schema vocabulary. */
export function schemaViolations(value: unknown, schema: JsonSchema, path: string): string[] {
  const violations: string[] = [];
  const type = schema.type;
  const fail = (reason: string): void => {
    violations.push(`${path} ${reason}`);
  };
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("must be an object");
      return violations;
    }
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) fail(`is missing ${key}`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) violations.push(...schemaViolations(record[key], propertySchema, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) fail(`has unknown property ${key}`);
      }
    }
    return violations;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      fail("must be an array");
      return violations;
    }
    const items = schema.items as JsonSchema | undefined;
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      fail(`needs at least ${schema.minItems} item(s)`);
    }
    // FIXED: analyze.yaml declares `maxItems` but the ported validator never enforced it.
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) {
      fail(`allows at most ${schema.maxItems} item(s)`);
    }
    if (items !== undefined) {
      value.forEach((item, index) => violations.push(...schemaViolations(item, items, `${path}[${index}]`)));
    }
    return violations;
  }
  if (type === "string") {
    if (typeof value !== "string") {
      fail("must be a string");
      return violations;
    }
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) fail("is too short");
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) fail("is too long");
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        fail("must be a URL");
      }
    }
    return violations;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      fail(`must be a ${type}`);
      return violations;
    }
    if (schema.minimum !== undefined && value < (schema.minimum as number)) fail("is below the minimum");
    if (schema.maximum !== undefined && value > (schema.maximum as number)) fail("is above the maximum");
    return violations;
  }
  if (type === "boolean" && typeof value !== "boolean") fail("must be a boolean");
  return violations;
}
