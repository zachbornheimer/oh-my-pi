import { askJson } from "./omp_model.ts";
import { type LanguageQuestion, languagePrompt } from "./questions.ts";
import type { StageEnv } from "./stage_types.ts";

/**
 * Asks one language question: its instructions, examples and `ground` as the prompt, the reply JSON checked by
 * `validate` (which throws to reject, the reason shown on the retry). Throws when no attempt is valid.
 */
export function askLanguage<T>(
  env: StageEnv,
  question: LanguageQuestion,
  ground: string,
  validate: (value: unknown) => T,
): Promise<T> {
  return askJson(env.step, languagePrompt(question, ground), validate, { signal: env.signal });
}

/** The language question named `field`; throws when the question file has none. */
export function languageNamed(
  file: { readonly language: Readonly<Record<string, LanguageQuestion>> },
  field: string,
): LanguageQuestion {
  const found = file.language[field];
  if (found === undefined) throw new Error(`question file has no ${field} question`);
  return found;
}
