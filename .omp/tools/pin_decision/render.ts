/**
 * The words a pinned decision is shown and answered in, owned here so the capability's text fallback and every
 * harness band speak the same reply shape. Only plain TypeScript, so a harness extension can load this file directly.
 */

interface Decision {
  readonly id: number;
  readonly question: string;
  readonly options: readonly string[];
}

/** The user message that answers a decision: `Decision <id> (<question>): <choice>`. */
export function answerMessage(decision: Decision, choice: string): string {
  return `Decision ${decision.id} (${decision.question}): ${choice}`;
}

/**
 * The pin as plain text, for a harness with no decision band: the question, its options numbered with the first
 * marked recommended, and the exact message that answers it.
 */
export function pinText(decision: Decision): string {
  const options = decision.options.map((option, index) =>
    `  ${index + 1}. ${option}${index === 0 ? " (recommended)" : ""}`
  );
  return [
    `Decision ${decision.id}: ${decision.question}`,
    ...options,
    `Pinned without blocking; keep working. The answer arrives as: ${answerMessage(decision, "<choice>")}`,
  ].join("\n");
}
