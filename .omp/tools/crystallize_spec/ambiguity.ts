/**
 * The ambiguity gate of a Socratic interview, lifted from Ouroboros (MIT, see NOTICE.md):
 * `src/ouroboros/bigbang/ambiguity.py`. Pure arithmetic over the clarity the grader gave each
 * dimension; the grader itself is the decision model (questions/interview.yaml).
 */

/** At most this much ambiguity lets a seed be written (ambiguity.py:37 AMBIGUITY_THRESHOLD). */
export const AMBIGUITY_THRESHOLD = 0.2;

/** The dimensions a grader scores and a question may target, in Ouroboros order (interview.py:630-635). */
export const DIMENSIONS = [
  "goal_clarity",
  "constraint_clarity",
  "success_criteria_clarity",
  "context_clarity",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Clarity per scored dimension, each from 0 (unclear) to 1 (perfectly specific). */
export type Breakdown = Readonly<Partial<Record<Dimension, number>>>;

/** The label each dimension carries in a floor failure (ambiguity.py:310-316). */
const LABELS: Readonly<Record<Dimension, string>> = {
  goal_clarity: "Goal Clarity",
  constraint_clarity: "Constraint Clarity",
  success_criteria_clarity: "Success Criteria Clarity",
  context_clarity: "Context Clarity",
};

/** The least clarity each dimension needs before the interview may end (ambiguity.py:42-46); context only for brownfield. */
export const FLOORS: Readonly<Record<Dimension, number>> = {
  goal_clarity: 0.75,
  constraint_clarity: 0.65,
  success_criteria_clarity: 0.70,
  context_clarity: 0.60,
};

/** Greenfield weights (ambiguity.py:48-51): three dimensions. */
const GREENFIELD_WEIGHTS: Readonly<Partial<Record<Dimension, number>>> = {
  goal_clarity: 0.40,
  constraint_clarity: 0.30,
  success_criteria_clarity: 0.30,
};

/** Brownfield weights (ambiguity.py:53-57): the existing codebase's context is a fourth dimension. */
const BROWNFIELD_WEIGHTS: Readonly<Partial<Record<Dimension, number>>> = {
  goal_clarity: 0.35,
  constraint_clarity: 0.25,
  success_criteria_clarity: 0.25,
  context_clarity: 0.15,
};

/** Decimal places the overall score keeps (ambiguity.py:852 `round(1.0 - weighted_clarity, 4)`). */
const SCORE_PRECISION = 10_000;

export type Milestone = "initial" | "progress" | "refined" | "ready";

/** Upper bound of each milestone, most advanced first (ambiguity.py:174-195, walked as `get_milestone` does). */
const MILESTONES: readonly (readonly [number, Milestone])[] = [
  [AMBIGUITY_THRESHOLD, "ready"],
  [0.3, "refined"],
  [0.4, "progress"],
  [1.0, "initial"],
];

/** What one grading of an interview settles. */
export interface Assessment {
  readonly ambiguity: number;
  readonly breakdown: Breakdown;
  readonly milestone: Milestone;
  readonly floor_failures: string[];
  readonly ready: boolean;
}

function weightsOf(brownfield: boolean): Readonly<Partial<Record<Dimension, number>>> {
  return brownfield ? BROWNFIELD_WEIGHTS : GREENFIELD_WEIGHTS;
}

/** The dimensions graded for this kind of work, in order: context only for brownfield. */
export function scoredDimensions(brownfield: boolean): Dimension[] {
  return DIMENSIONS.filter((dimension) => weightsOf(brownfield)[dimension] !== undefined);
}

/** ambiguity = 1 - Σ weight·clarity, kept to 4 decimals; a dimension left ungraded counts as 0 clarity. */
export function ambiguityOf(breakdown: Breakdown, brownfield: boolean): number {
  const weights = weightsOf(brownfield);
  const clarity = scoredDimensions(brownfield).reduce(
    (sum, dimension) => sum + weights[dimension]! * (breakdown[dimension] ?? 0),
    0,
  );
  return Math.round((1 - clarity) * SCORE_PRECISION) / SCORE_PRECISION;
}

/** Each floor the breakdown misses, worded as `get_completion_floor_failures` words it (ambiguity.py:299-321). */
export function floorFailures(breakdown: Breakdown, brownfield: boolean): string[] {
  return scoredDimensions(brownfield).flatMap((dimension) => {
    const floor = FLOORS[dimension];
    const clarity = breakdown[dimension];
    if (clarity === undefined) return [`${LABELS[dimension]} missing (< ${floor.toFixed(2)})`];
    return clarity < floor ? [`${LABELS[dimension]} ${clarity.toFixed(2)} < ${floor.toFixed(2)}`] : [];
  });
}

/** Ready for a seed: ambiguity at most the threshold and no floor missed (ambiguity.py:324-336). */
export function isReady(ambiguity: number, failures: readonly string[]): boolean {
  return ambiguity <= AMBIGUITY_THRESHOLD && failures.length === 0;
}

/** The most advanced milestone the score has reached. */
export function milestoneOf(ambiguity: number): Milestone {
  return MILESTONES.find(([bound]) => ambiguity <= bound)?.[1] ?? "initial";
}

/** Everything one grading settles, from the clarity of each dimension. */
export function assess(breakdown: Breakdown, brownfield: boolean): Assessment {
  const ambiguity = ambiguityOf(breakdown, brownfield);
  const failures = floorFailures(breakdown, brownfield);
  return {
    ambiguity,
    breakdown,
    milestone: milestoneOf(ambiguity),
    floor_failures: failures,
    ready: isReady(ambiguity, failures),
  };
}
