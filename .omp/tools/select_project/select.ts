import { selectProjectInput } from "./input.js";
import { askJson, type ModelStep } from "./omp_model.js";
import {
  chosenFrom,
  menuNames,
  NEW_PROJECT_CHOICE,
  NEW_PROJECT_CRITERIA,
  PROJECT_FIELD,
  PROJECT_INSTRUCTIONS,
  refuseReservedName,
  selected,
} from "./selection.js";
import { subjectText } from "./thread.js";
import type { Selected } from "./types.js";

export interface SelectProjectDeps {
  step: ModelStep;
  signal?: AbortSignal;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one model request: the question, the menu (live project names, then `new`), the thread fenced as data, the reply shape. */
export function projectPrompt(thread: string, names: readonly string[]): string {
  return [
    `## ${PROJECT_FIELD}`,
    PROJECT_INSTRUCTIONS,
    "Menu (reply with exactly one entry's name):",
    ...names.map((name) => `- ${JSON.stringify(name)}`),
    `- "${NEW_PROJECT_CHOICE}": ${NEW_PROJECT_CRITERIA}`,
    "",
    thread,
    "",
    "Reply with only a JSON object.",
    `Respond as JSON matching this shape: {"${PROJECT_FIELD}": ${[...names, NEW_PROJECT_CHOICE].map((name) => JSON.stringify(name)).join(" | ")}, "confidence": <your probability, from 0 to 1, that this entry is right>}`,
  ].join("\n");
}

/** The pick a reply states; throws, naming what is wrong, when it is not on the menu or has no confidence. */
export function parsePick(names: readonly string[]): (value: unknown) => { choice: string; confidence: number } {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`the reply must be a JSON object {"${PROJECT_FIELD}": string, "confidence": number}`);
    }
    const reply = value as Record<string, unknown>;
    const given = reply[PROJECT_FIELD];
    const choice = typeof given === "string" ? given.trim() : "";
    chosenFrom(choice, names);
    const confidence = reply.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`confidence must be a number from 0 to 1, got ${JSON.stringify(confidence)}`);
    }
    return { choice, confidence };
  };
}

/**
 * Which project is this thread? One model run over a menu of the live projects and `new`. With no live project the
 * answer is `new` and no model is asked. A failed ask throws `ask which project: <cause>`.
 */
export async function runSelectProject(params: unknown, deps: SelectProjectDeps): Promise<Selected> {
  const input = selectProjectInput(params);
  const names = menuNames(input.Projects);
  if (names.length === 0) return selected(NEW_PROJECT_CHOICE);
  refuseReservedName(names);
  try {
    const pick = await askJson(deps.step, projectPrompt(subjectText(input), names), parsePick(names), { signal: deps.signal });
    return selected(pick.choice, input.Projects, pick.confidence);
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`ask which project: ${messageOf(error)}`);
  }
}
