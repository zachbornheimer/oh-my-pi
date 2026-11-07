import type { Design } from "./schemas.js";
import { wordsOf } from "./words.js";

/** A number the pseudocode mentions; 0 and 1 are not magic. */
const NUMBER_LITERAL = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;
const NOT_MAGIC = new Set(["0", "1"]);

/** The design as the model reads it. */
export function designBrief(design: Design): string {
  if (typeof design === "string") return design.trim();
  const lines = [
    `Name: ${design.name}`,
    `Purpose: ${design.purpose}`,
    `Input: ${design.input_summary}`,
    `Output: ${design.output_summary}`,
    `Pseudocode:\n${design.pseudocode}`,
  ];
  if (design.replaces !== undefined && design.replaces.length > 0) {
    lines.push(`Replaces: ${design.replaces.join(", ")}`);
  }
  return lines.join("\n");
}

export interface DesignWords {
  /** Words of the design's name; empty when the design is plain text. */
  readonly name: readonly string[];
  /** Every other word of the design. */
  readonly rest: readonly string[];
}

export function designWords(design: Design): DesignWords {
  if (typeof design === "string") return { name: [], rest: wordsOf(design) };
  const name = wordsOf(design.name);
  const rest = wordsOf(designBrief({ ...design, name: "" }));
  return { name, rest: rest.filter((word) => !name.includes(word)) };
}

/** The numbers (other than 0 and 1) written in the design, which the code must give a name. */
export function designNumbers(design: Design): string[] {
  const text = typeof design === "string" ? design : design.pseudocode;
  const found = text.match(NUMBER_LITERAL) ?? [];
  return [...new Set(found.filter((number) => !NOT_MAGIC.has(number)))];
}

/** The names the design replaces. */
export const replacedNames = (
  design: Design,
): readonly string[] => (typeof design === "string" ? [] : design.replaces ?? []);
