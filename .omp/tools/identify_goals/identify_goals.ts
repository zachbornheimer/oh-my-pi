import { type Answer, decisionPrompt, parseDecisions } from "./decide.js";
import {
  checkGoalAnswer,
  GOAL_INTRO,
  GOAL_QUESTIONS,
  outcomesPrompt,
  parseClaims,
  recordGoals,
  type Segments,
  type StatedGoal,
  subjectText,
} from "./goals.js";
import { type AssessedPart, ASSESS_CONCURRENCY, type IdentifyIntentResult, runIdentifyIntent, type IntentDeps } from "./intent.js";
import { askJson, mapLimit } from "./omp_model.js";
import { newPromptId } from "./segment.js";

/** What the model stated about the goals one part states or implies. */
export interface GoalDecisions {
  Role: { Value: string };
  Explicit: boolean;
  Verifiable: boolean;
  Urgency: { Value: string };
  Scope: { Value: string };
}

export interface PartWithGoals extends AssessedPart {
  Goals: GoalDecisions;
}

export interface IdentifyGoalsResult {
  ID: string;
  Content: string;
  Parts: PartWithGoals[];
  Goals: StatedGoal[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function goalDecisions(answers: Record<string, Answer>): GoalDecisions {
  return {
    Role: answers.Role as { Value: string },
    Explicit: answers.Explicit as boolean,
    Verifiable: answers.Verifiable as boolean,
    Urgency: answers.Urgency as { Value: string },
    Scope: answers.Scope as { Value: string },
  };
}

/**
 * identify_intent, then — together — the five goal questions for every part and one call that merges the goals,
 * each cited to the segments it came from. The first failure of either branch fails the run.
 */
export async function runIdentifyGoals(
  text: unknown,
  deps: IntentDeps,
  intentOf: (text: unknown, deps: IntentDeps) => Promise<IdentifyIntentResult> = runIdentifyIntent,
): Promise<IdentifyGoalsResult> {
  let intent: IdentifyIntentResult;
  try {
    intent = await intentOf(text, deps);
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`identify intent: ${messageOf(error)}`);
  }
  const words = intent.Content;
  const segments: Segments = { promptId: newPromptId(), content: words, parts: intent.Parts };

  // The two branches run together; the first failure stops the other's model calls too.
  const stop = new AbortController();
  const signal = deps.signal === undefined ? stop.signal : AbortSignal.any([deps.signal, stop.signal]);

  const askOutcomes = async (): Promise<StatedGoal[]> => {
    const claims = await askJson(
      deps.step,
      outcomesPrompt(segments),
      (value) => {
        const claimed = parseClaims(value);
        checkGoalAnswer(segments, claimed);
        return claimed;
      },
      { signal },
    );
    return recordGoals(claims);
  };

  const decideParts = (): Promise<GoalDecisions[]> =>
    mapLimit(segments.parts, deps.concurrency ?? ASSESS_CONCURRENCY, async (part, index) => {
      try {
        const answers = await askJson(
          deps.step,
          decisionPrompt(GOAL_INTRO, GOAL_QUESTIONS, subjectText(part), words),
          (value) => parseDecisions(GOAL_QUESTIONS, value),
          { signal },
        );
        return goalDecisions(answers);
      } catch (error) {
        deps.signal?.throwIfAborted();
        throw new Error(`item ${index}: ${messageOf(error)}`);
      }
    });

  let goals: StatedGoal[];
  let decided: GoalDecisions[];
  try {
    [goals, decided] = await Promise.all([askOutcomes(), decideParts()]);
  } catch (error) {
    stop.abort(error);
    deps.signal?.throwIfAborted();
    throw new Error(`identify the goals: ${messageOf(error)}`);
  }
  return {
    ID: segments.promptId,
    Content: words,
    Parts: segments.parts.map((part, index) => ({ ...part, Goals: decided[index]! })),
    Goals: goals,
  };
}
