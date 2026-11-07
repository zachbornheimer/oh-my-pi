import type { CreateDagInput, WorkUnit } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a list of strings`);
  }
  return value as string[];
}

function text(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/** One unit with every omitted or null field empty; throws, naming the field, on a wrong type. */
function unitOf(value: unknown, index: number): WorkUnit {
  if (!isRecord(value)) throw new Error(`units[${index}] must be an object`);
  const at = (field: string): string => `units[${index}].${field}`;
  return {
    id: text(value.id, at("id")),
    statement: text(value.statement, at("statement")),
    obligations: strings(value.obligations, at("obligations")),
    constraints: strings(value.constraints, at("constraints")),
    resources: strings(value.resources, at("resources")),
    tools: strings(value.tools, at("tools")),
  };
}

/** The request `{units?, text?}` with null and omitted fields empty; throws on a field of the wrong type. */
export function readRequest(value: unknown): CreateDagInput {
  if (!isRecord(value)) throw new Error("the request must be an object with `units` and/or `text`");
  const units = value.units == null ? [] : value.units;
  if (!Array.isArray(units)) throw new Error("units must be a list");
  return { units: units.map(unitOf), text: text(value.text, "text") };
}

/**
 * The request a run works on. Text that is itself a JSON request with units (or non-empty text) is that request;
 * any other text stays text.
 */
export function parseRequest(input: CreateDagInput): CreateDagInput {
  const body = input.text.trim();
  if (input.units.length > 0 || !body.startsWith("{")) return input;
  try {
    const inner = readRequest(JSON.parse(body));
    if (inner.units.length > 0 || inner.text.trim() !== "") return inner;
  } catch {
    // not a request: the text is the work
  }
  return input;
}
