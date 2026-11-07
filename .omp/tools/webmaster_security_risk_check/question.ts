import { readFileSync } from "node:fs";

/** The model's two questions, read from the question file beside this tool (`webmaster_security_risk_check.yaml`). */
export interface LanguageQuestion {
  field: string;
  instructions: string;
  examples: string[];
  schema: Record<string, unknown>;
}

const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

interface RawQuestion {
  instructions: string;
  schema: Record<string, unknown>;
  examples?: unknown[];
}

let cached: Record<string, LanguageQuestion> | undefined;

/** The question for `field` (`Profile` or `Conditions`). Throws when the file does not have it. */
export function questionOf(field: "Profile" | "Conditions"): LanguageQuestion {
  if (cached === undefined) {
    const raw = Bun.YAML.parse(readFileSync(new URL("./webmaster_security_risk_check.yaml", import.meta.url), "utf8")) as Record<string, RawQuestion>;
    cached = Object.fromEntries(
      Object.entries(raw).map(([name, entry]) => [
        name,
        {
          field: name,
          instructions: entry.instructions.trim(),
          examples: (entry.examples ?? []).map((example) => (typeof example === "string" ? example.trim() : Bun.YAML.stringify(example, null, 4).trim())),
          schema: entry.schema,
        },
      ]),
    );
  }
  const question = cached[field];
  if (question === undefined) throw new Error(`webmaster_security_risk_check.yaml has no ${field} question`);
  return question;
}

/** The JSON Schema of a reply: an object whose one required key is the question's field. */
export function replySchema(question: LanguageQuestion): Record<string, unknown> {
  return { type: "object", properties: { [question.field]: question.schema }, required: [question.field], additionalProperties: false };
}

/** What the model reads for one question: instructions, examples, the input, then the reply schema. */
export function languagePrompt(question: LanguageQuestion, input: string): string {
  const examples = question.examples.map((example) => `Example:\n${example}\n`).join("");
  return `## ${question.field}\n${question.instructions}\n${examples}\nPrompt:\n${input}\n${SCHEMA_LEAD}${JSON.stringify(replySchema(question))}`;
}
