import type { Classification } from "./classify.js";

/** The three categories of the pair question. */
export const PAIR_CATEGORIES = ["a_before_b", "b_before_a", "independent"] as const;
export type PairCategory = (typeof PAIR_CATEGORIES)[number];

/** Mastra's `plan_infer_dependency.yaml`, unchanged: the question, the 0.6 threshold, the categories and the examples. */
export const PAIR_CLASSIFICATION: Classification = {
  question: "Given two planned goals, A and B, must one finish before the other can start?",
  threshold: 0.6,
  categories: [
    {
      id: "a_before_b",
      criteria:
        "B cannot start until A finishes: B uses something A creates, renames, or changes (a file, symbol, interface, schema, or result).",
    },
    {
      id: "b_before_a",
      criteria:
        "A cannot start until B finishes: A uses something B creates, renames, or changes (a file, symbol, interface, schema, or result).",
    },
    {
      id: "independent",
      criteria: "The two goals touch unrelated things and can run in either order or in parallel.",
    },
  ],
  examples: [
    { text: "Goal A: write the report\nGoal B: publish the report", category: "a_before_b" },
    { text: "Goal A: run the migration against staging\nGoal B: write the migration", category: "b_before_a" },
    {
      text: "Goal A: rename field user_id to account_id in schema.go\nGoal B: add an endpoint returning account_id",
      category: "a_before_b",
    },
    { text: "Goal A: buy flour\nGoal B: buy eggs", category: "independent" },
  ],
};

/** One planned goal as the dependency judge sees it. */
export interface DependencyGoal {
  id: string;
  statement: string;
  criteria?: string[];
}

/** Goal `from` must wait for goal `to`, by goal id. */
export interface GoalDependency {
  from: string;
  to: string;
}

/** 0 unsure, 1 certain. */
export const UNSURE = 0;
export const CERTAIN = 1;
export type Certainty = typeof UNSURE | typeof CERTAIN;

/** The judged relation between the earlier and later goal of one unordered pair. */
export type PairOrder = "earlier_first" | "later_first" | "unordered";

/** The unsure fallback: a missing edge silently drops ordering that matters, a false edge only costs time. */
export const UNSURE_PAIR_ORDER: PairOrder = "earlier_first";

export function interpretPairOrder(category: string): PairOrder | undefined {
  switch (category) {
    case "a_before_b":
      return "earlier_first";
    case "b_before_a":
      return "later_first";
    case "independent":
      return "unordered";
    default:
      return undefined;
  }
}

/** One unordered pair, as indexes into the goals, earlier first. */
export interface GoalPair {
  readonly earlier: number;
  readonly later: number;
}

/** Every unordered pair, earlier goal first, in input order. */
export function pairsOf(count: number): GoalPair[] {
  const pairs: GoalPair[] = [];
  for (let earlier = 0; earlier < count; earlier++) {
    for (let later = earlier + 1; later < count; later++) pairs.push({ earlier, later });
  }
  return pairs;
}

/** Refuses a goal with no id (blank counts) or an id used twice. */
export function checkGoalIds(goals: readonly DependencyGoal[]): void {
  const seen = new Set<string>();
  goals.forEach((goal, index) => {
    if (goal.id.trim() === "") {
      throw new Error(`infer dependency: goal ${index} (${JSON.stringify(goal.statement)}) has no id`);
    }
    if (seen.has(goal.id)) throw new Error(`infer dependency: duplicate goal id ${JSON.stringify(goal.id)}`);
    seen.add(goal.id);
  });
}

function goalBlock(label: "A" | "B", goal: DependencyGoal): string {
  const lines = [`Goal ${label}: ${goal.statement}\n`, `Goal ${label} id: ${goal.id}\n`];
  for (const criterion of goal.criteria ?? []) lines.push(`Goal ${label} criterion: ${criterion}\n`);
  return lines.join("");
}

/** Two goals as labelled lines, so no step text can be confused for the separator between them. */
export function pairText(earlier: DependencyGoal, later: DependencyGoal): string {
  return `${goalBlock("A", earlier)}\n${goalBlock("B", later)}`;
}

/** The edge a judged pair adds, if any. */
export function edgeFor(order: PairOrder, earlierId: string, laterId: string): GoalDependency | undefined {
  switch (order) {
    case "earlier_first":
      return { from: laterId, to: earlierId };
    case "later_first":
      return { from: earlierId, to: laterId };
    case "unordered":
      return undefined;
  }
}
