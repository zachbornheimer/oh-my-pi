import { type Classification, classify } from "./classify.js";
import type { ModelStep } from "./omp_model.js";
import { BULLET_PREFIXES } from "./text.js";

export type Atomicity = "atomic" | "compound";

/** Mastra's `check_atomicity.yaml`, verbatim: the question, the 0.7 threshold, the two categories and seven worked examples. */
export const ATOMICITY_CLASSIFICATION: Classification = {
  question: "Is this one atomic unit of work, or several bundled together?",
  threshold: 0.7,
  categories: [
    {
      id: "atomic",
      criteria:
        'One actionable outcome a reviewer could verify on its own. Several clauses, commas, bullets or the word "and" can still describe one outcome (one rename, one task with acceptance criteria, steps of one change).',
    },
    {
      id: "compound",
      criteria:
        "Several independent outcomes bundled into one unit; each needs its own verification. Bundled outcomes may run together with no commas, bullets or conjunctions.",
    },
  ],
  examples: [
    { text: "Add a dark mode toggle to the settings page.", category: "atomic" },
    { text: "Fix the login bug and also refactor the auth module and update the docs.", category: "compound" },
    { text: "Bump the version string in package.json and commit.", category: "atomic" },
    { text: "Rewrite the API layer, migrate the database, and redesign the dashboard.", category: "compound" },
    { text: "Rewrite the API layer migrate the database redesign the dashboard", category: "compound" },
    {
      text: "Rename the field `userId` to `accountId` across the API, the DB schema, and the client SDK, keeping behavior identical.",
      category: "atomic",
    },
    {
      text: "- Run go test ./...\n- Output must be green\n(acceptance criteria for: Fix flaky TestFoo)",
      category: "atomic",
    },
  ],
};

const AND_ALSO = " and also ";
const COMPOUND_COMMA_MIN = 3;
const COMPOUND_BULLET_MIN = 2;

const asAtomicity = (id: string): Atomicity | undefined => (id === "atomic" || id === "compound" ? id : undefined);

/** The menu's own worked example whose text is this text exactly. */
export function shippedAtomicity(text: string): Atomicity | undefined {
  const example = ATOMICITY_CLASSIFICATION.examples.find((candidate) => candidate.text.trim() === text);
  return example === undefined ? undefined : asAtomicity(example.category);
}

const lines = (text: string): string[] => text.split("\n");
const bulletCount = (text: string): number =>
  lines(text).filter((raw) => BULLET_PREFIXES.some((prefix) => raw.trim().startsWith(prefix))).length;
const commaClauses = (text: string): number => text.split(",").filter((part) => part.trim() !== "").length;
const nonBlankLines = (text: string): number => lines(text).filter((raw) => raw.trim() !== "").length;

/** Atomicity from the text's own shape: bullets, "and also" or three comma clauses are compound; one line is atomic. */
export function shapeAtomicity(text: string): Atomicity | undefined {
  if (
    bulletCount(text) >= COMPOUND_BULLET_MIN
    || text.toLowerCase().includes(AND_ALSO)
    || commaClauses(text) >= COMPOUND_COMMA_MIN
  ) {
    return "compound";
  }
  return nonBlankLines(text) === 1 ? "atomic" : undefined;
}

/**
 * Is this statement one outcome? In order: blank is compound; then the menu's own examples; then the text's shape;
 * only then the model. A model that cannot answer, or states under 0.7, means compound: an unclear unit is split
 * rather than declared done. Only an abort is thrown.
 */
export async function judgeAtomicity(statement: string, step: ModelStep, signal?: AbortSignal): Promise<Atomicity> {
  const text = statement.trim();
  if (text === "") return "compound";
  const known = shippedAtomicity(text) ?? shapeAtomicity(text);
  if (known !== undefined) return known;
  try {
    const pick = await classify(step, ATOMICITY_CLASSIFICATION, text, signal);
    if (pick.probability < ATOMICITY_CLASSIFICATION.threshold) return "compound";
    return asAtomicity(pick.choice) ?? "compound";
  } catch {
    signal?.throwIfAborted();
    return "compound";
  }
}
