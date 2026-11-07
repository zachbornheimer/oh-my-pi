/** The kind of model a task asks for. */
export type ModelKind = "decision" | "language";

/**
 * Words that mark a task wanting text written rather than a decision made (agentmux `languageTaskWords`: `descri`,
 * `write`, `generat`, `llm`, `text`). Each is matched at the start of a word, so `context` is not `text`; `writing`,
 * `written` and `rewrite` count as `write`.
 */
const LANGUAGE_TASK_WORDS = /(?<![\p{L}\p{N}])(descri|re-?writ(e|es|ing|ten)|writ(e|es|ing|ten)|generat|llm|text)/iu;

/** A language model when the prompt asks for text to be written, a decision model otherwise. */
export function needOf(prompt: string): ModelKind {
  return LANGUAGE_TASK_WORDS.test(prompt) ? "language" : "decision";
}
