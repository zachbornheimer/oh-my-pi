import { readFileSync } from "node:fs";

/** The model's question, read from the question file beside this tool (`wordpress_inventory.yaml`). */
interface QuestionField {
  instructions: string;
  schema: unknown;
  examples: { prompt: string; answer: unknown }[];
}

const FIELD = "Inventory";
const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

function load(): QuestionField {
  const parsed = Bun.YAML.parse(readFileSync(new URL("./wordpress_inventory.yaml", import.meta.url), "utf8")) as Record<string, QuestionField>;
  const field = parsed[FIELD];
  if (field === undefined || typeof field.instructions !== "string" || !field.instructions.includes("{evidence}")) {
    throw new Error("wordpress_inventory.yaml has no Inventory question with an {evidence} slot");
  }
  return field;
}

let loaded: QuestionField | undefined;

/** The reply schema: an object whose one required key is the question's field. */
export function replySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { [FIELD]: (loaded ??= load()).schema },
    required: [FIELD],
    additionalProperties: false,
  };
}

/** What the model reads: the instructions with the evidence in, the example, then the reply schema. */
export function promptFor(evidence: string): string {
  const field = (loaded ??= load());
  const instructions = field.instructions.replaceAll("{evidence}", () => evidence);
  const examples = field.examples
    .map((example) => `Example:\n${example.prompt}\n\nExample answer:\n${JSON.stringify({ [FIELD]: example.answer })}\n`)
    .join("\n");
  return `## ${FIELD}\n${instructions}\n\n${examples}${SCHEMA_LEAD}${JSON.stringify(replySchema())}\n`;
}
