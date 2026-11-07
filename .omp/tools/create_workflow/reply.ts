import { LEAF_KINDS, type Leaf, type LeafKind, type Member } from "./types.js";

/**
 * Hand-written validators for what a model replies. Each throws a reason written for the model (`askJson` shows it on
 * the retry). Keys a reply carries beyond the ones read are ignored, as Mastra's zod objects strip them.
 */

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

/** The object a reply is, whose one required key `field` holds the answer. */
export function replyField(reply: unknown, field: string): unknown {
  if (!isRecord(reply)) throw new Error(`the reply must be a JSON object with the key "${field}"`);
  if (!(field in reply)) throw new Error(`the reply has no "${field}" key: answer as {"${field}": ...}`);
  return reply[field];
}

export function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array, got ${shown(value)}`);
  return value;
}

export function recordAt(value: unknown, path: string): Json {
  if (!isRecord(value)) throw new Error(`${path} must be an object, got ${shown(value)}`);
  return value;
}

/** A string; `nonEmpty` refuses one that is empty. */
export function stringAt(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string, got ${shown(value)}`);
  if (nonEmpty && value === "") throw new Error(`${path} must not be empty`);
  return value;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be true or false, got ${shown(value)}`);
  return value;
}

/** A non-empty array of non-empty strings. */
export function namesAt(value: unknown, path: string): string[] {
  const items = arrayAt(value, path);
  if (items.length === 0) throw new Error(`${path} must hold at least one entry`);
  return items.map((item, index) => stringAt(item, `${path}[${index}]`, true));
}

export function kindAt(value: unknown, path: string): LeafKind {
  if (typeof value !== "string" || !(LEAF_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${path} must be one of ${LEAF_KINDS.join(", ")}, got ${shown(value)}`);
  }
  return value as LeafKind;
}

export function memberAt(value: unknown, path: string): Member {
  const member = recordAt(value, path);
  const sample = member.sample;
  if (typeof sample !== "number" || !Number.isInteger(sample) || sample < 1) {
    throw new Error(`${path}.sample must be a whole number from 1, got ${shown(sample)}`);
  }
  return { sample, name: stringAt(member.name, `${path}.name`, true) };
}

export function leafAt(value: unknown, path: string): Leaf {
  const leaf = recordAt(value, path);
  return {
    name: stringAt(leaf.name, `${path}.name`, true),
    purpose: stringAt(leaf.purpose, `${path}.purpose`, true),
    reason: stringAt(leaf.reason, `${path}.reason`, true),
    input_summary: stringAt(leaf.input_summary, `${path}.input_summary`, true),
    output_summary: stringAt(leaf.output_summary, `${path}.output_summary`, true),
    input_fields: namesAt(leaf.input_fields, `${path}.input_fields`),
    output_fields: namesAt(leaf.output_fields, `${path}.output_fields`),
    kind: kindAt(leaf.kind, `${path}.kind`),
    evidence: namesAt(leaf.evidence, `${path}.evidence`),
  };
}
