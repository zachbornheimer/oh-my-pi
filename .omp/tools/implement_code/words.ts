const WORD = /[A-Za-z][A-Za-z0-9]*/g;
const LOWER_TO_UPPER = /([a-z0-9])([A-Z])/g;
const MIN_WORD_LENGTH = 3;
const FILLER = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "its",
  "are",
  "was",
  "has",
  "have",
  "not",
  "any",
  "each",
  "when",
  "then",
  "than",
  "takes",
  "returns",
  "gets",
  "one",
  "new",
]);

/** The lower-case words in `text`, splitting snake_case, kebab-case and camelCase; filler and very short words dropped. */
export function wordsOf(text: string): string[] {
  const pieces = text.replace(LOWER_TO_UPPER, "$1 $2").match(WORD) ?? [];
  return pieces.map((piece) => piece.toLowerCase()).filter((word) =>
    word.length >= MIN_WORD_LENGTH && !FILLER.has(word)
  );
}
