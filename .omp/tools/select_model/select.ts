import { needOf } from "./need.js";
import { modelsFor } from "./ranking.js";

export const NO_PROMPT_MESSAGE = "select_model requires a task prompt";

export interface Selection {
  Candidates: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Ranks the registered models that can answer a task, best fit first. Pure: no model is asked. A blank prompt throws
 * `select_model requires a task prompt`; any other failure throws `select a model for <prompt>: <reason>`.
 */
export function selectModel(text: unknown, env: Env): Selection {
  const prompt = typeof text === "string" ? text.trim() : "";
  if (prompt === "") throw new Error(NO_PROMPT_MESSAGE);
  try {
    return { Candidates: modelsFor(needOf(prompt), env) };
  } catch (error) {
    throw new Error(`select a model for ${JSON.stringify(prompt)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
