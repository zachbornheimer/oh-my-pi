import type { Question } from "./decide.js";
import type { AssessedPart } from "./intent.js";

/** The five questions asked of every part about the goals it states or implies (questions/identify_goals.yaml). */
export const GOAL_QUESTIONS: readonly Question[] = [
  {
    field: "Role",
    kind: "choice",
    instructions: "What role does this segment play in what the user wants?",
    options: {
      request: "Work the user wants done, including a problem they report so it gets fixed.",
      promised_outcome: "A result the user said will be delivered.",
      constraint: "A limit on how the work may be done.",
      ask: "A question the user wants answered, not work to do.",
    },
  },
  {
    field: "Explicit",
    kind: "yesno",
    instructions: "Does this segment state its goal outright, rather than leaving it to be inferred?",
    yes: "The user says plainly what they want.",
    no: "The goal has to be inferred from a report, complaint, or hint.",
  },
  {
    field: "Verifiable",
    kind: "yesno",
    instructions: "Could someone check, without asking the user, that this segment's goal is done?",
    yes: "There is an observable result that shows the goal is met.",
    no: "Whether it is done depends on the user's judgment or is unclear.",
  },
  {
    field: "Urgency",
    kind: "choice",
    instructions: "How urgent is this segment's goal to the user?",
    options: {
      now: "Something is broken or blocking and the user wants it fixed promptly.",
      soon: "Wanted, but nothing is blocked if it waits a little.",
      whenever: "A nice-to-have or a someday improvement.",
    },
  },
  {
    field: "Scope",
    kind: "choice",
    instructions: "How much work does this segment's goal likely take?",
    options: {
      single_change: "One focused change in one place.",
      several_changes: "Several related changes, possibly in a few places.",
      ongoing: "Continuing work or a standing practice, not a one-time change.",
    },
  },
];

export const GOAL_INTRO =
  "Judge one segment of a user's input: what goals it states or implies. Answer every question below about that segment only; the whole input is given as context.";

/** The goals question (questions/identify_goals_outcomes.yaml `Goals`). */
export const OUTCOME_INSTRUCTIONS =
  "The input is listed as items, each with an id. Every item but the last is a segment of a user's input; the last item is the whole input. We are trying to classify what the user wants. Based on each segment, what are the desired goal, or goals, that the user has? Include any implied goals. Answer about each segment on its own. Return the final list of unique goals: goals that are the same outcome become one goal, and its wording keeps every specific detail. Each goal cites the id of every segment it comes from, and a goal that spans segments cites every segment it spans. Cite the id of the last item only for a goal that no segment states and only the whole input implies; never cite it alongside a segment. Cite ids exactly as listed.";

export const OUTCOME_EXAMPLE = `Example:
Prompt: "the invoice PDF still shows last month's total, and add a CSV export"
Answer: ${JSON.stringify([
  { outcome: "Fix the invoice PDF so it shows the current invoice's total.", sources: ["<id of the segment>"] },
  { outcome: "Add a CSV export of invoice data.", sources: ["<id of the segment>"] },
])}`;

export const OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    Goals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          outcome: { type: "string", minLength: 1 },
          sources: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["outcome", "sources"],
      },
    },
  },
  required: ["Goals"],
  additionalProperties: false,
};

/** One goal of the prompt and the segments that state it. */
export interface StatedGoal {
  outcome: string;
  sources: string[];
}

export interface GoalClaim {
  outcome: string;
  sources: string[];
}

/** The ids a goal may cite: every part and the whole prompt. */
export interface Segments {
  readonly promptId: string;
  readonly content: string;
  readonly parts: readonly AssessedPart[];
}

const ASSESSED_LEAD = "Assessed as: ";

/** "Type / Intent" as identify_intent assessed the part; empty when it assessed neither. */
export function assessedAs(part: AssessedPart): string {
  return [part.Type.Value, part.Intent.Value].filter((value) => value !== "").join(" / ");
}

/** A part as the subject of a question: its words, then what identify_intent made of it. */
export function subjectText(part: AssessedPart): string {
  const assessed = assessedAs(part);
  return assessed === "" ? part.Content : `${part.Content}\n${ASSESSED_LEAD}${assessed}`;
}

/** Go's encoding/json escapes `<`, `>`, `&`, U+2028 and U+2029 beyond JSON's own; the Mastra twin's goals prompt does too. */
const goEscaped = (text: string): string =>
  text.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const listedLine = (id: string, text: string): string => `${goEscaped(JSON.stringify({ id, text }))}\n`;

/** The input as the model reads it: one JSON line per part (id and subject text), then the whole input with the prompt's id. */
export function segmentedInput(segments: Segments): string {
  const lines = segments.parts.map((part) => listedLine(part.ID, subjectText(part)));
  return lines.join("") + listedLine(segments.promptId, segments.content);
}

/** The whole outcomes prompt: instructions, the example, the listed input, then the reply schema last. */
export function outcomesPrompt(segments: Segments): string {
  return [
    "## Goals",
    OUTCOME_INSTRUCTIONS,
    OUTCOME_EXAMPLE,
    "",
    "Prompt:",
    segmentedInput(segments),
    "Respond as JSON matching this schema:",
    JSON.stringify(OUTCOME_SCHEMA),
  ].join("\n");
}

/** The goals a reply carries: `{"Goals": [...]}` or the bare array; throws on a wrong shape. */
export function parseClaims(value: unknown): GoalClaim[] {
  const goals = Array.isArray(value) ? value : (value as { Goals?: unknown } | null)?.Goals;
  if (!Array.isArray(goals)) throw new Error('the reply must be {"Goals": [{outcome, sources}, ...]}');
  return goals.map((goal: unknown, index: number) => {
    const { outcome, sources } = (goal ?? {}) as { outcome?: unknown; sources?: unknown };
    if (typeof outcome !== "string") throw new Error(`goal ${index} outcome must be a string`);
    if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
      throw new Error(`goal ${index} sources must be an array of ids`);
    }
    return { outcome, sources: sources as string[] };
  });
}

function claimProblems(n: number, claim: GoalClaim, known: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (claim.outcome.trim() === "") problems.push(`goal ${n} has no outcome`);
  if (claim.sources.length === 0) problems.push(`goal ${n} cites no source`);
  for (const source of claim.sources) {
    if (!known.has(source)) {
      problems.push(`goal ${n} cites ${JSON.stringify(source)}, which is not the id of a listed item`);
    }
  }
  return problems;
}

/** Throws what to fix, written for the model, unless every goal has an outcome and cites only listed ids. */
export function checkGoalAnswer(segments: Segments, claims: readonly GoalClaim[]): void {
  const known = new Set([segments.promptId, ...segments.parts.map((part) => part.ID)]);
  const problems = claims.flatMap((claim, n) => claimProblems(n, claim, known));
  if (problems.length > 0) throw new Error(`fix the answer: ${problems.join("; ")}`);
}

/** The prompt's goals from a checked answer; a goal's repeated sources are listed once. */
export function recordGoals(claims: readonly GoalClaim[]): StatedGoal[] {
  return claims.map((claim) => ({ outcome: claim.outcome, sources: [...new Set(claim.sources)] }));
}
