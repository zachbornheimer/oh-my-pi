/** One error's message, whatever it is. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How much of a dead worker's output tail a failure answer carries. */
export const ERROR_TAIL_CHARS = 400;

/** The last at most `maxChars` of `text`, trimmed: a bounded tail, never a whole log. */
export function tailOf(text: string, maxChars: number = ERROR_TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

/** Quotes one word for POSIX `sh`: single quotes, with the embedded quote closed and reopened. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The signal's abort reason as an Error, so a rejected wait always carries something throwable. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(reason === undefined ? "aborted" : String(reason));
}
