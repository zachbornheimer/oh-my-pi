/**
 * The lexical half of `find`: turn a query into weighted terms and score text against them.
 * Pure, so the host scan and the tests use one definition of "relevant".
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into",
  "when", "where", "what", "which", "how", "does", "did", "are",
  "was", "were", "has", "have", "had", "not", "but", "you",
  "your", "its", "it", "a", "an", "of", "to", "in",
  "on", "or", "is", "be", "as", "at", "by", "if",
  "we", "i", "can", "will", "should", "would", "could", "all",
  "any", "each", "more", "most", "some", "such", "than", "then",
  "there", "these", "they", "their", "them", "also", "only", "over",
  "under", "after", "before", "between", "about", "across", "per", "via",
  "one", "two", "use", "used", "using", "get", "gets", "set",
  "sets",
]);

const MIN_TERM_LENGTH = 3;
const MIN_STEM_LENGTH = 4;
const SUFFIXES = ["ing", "ed", "es", "s"] as const;

/** `running` → `runn`, `parsed` → `pars`; only when the stem still says something. */
function stem(term: string): string {
  for (const suffix of SUFFIXES) {
    if (term.endsWith(suffix) && term.length - suffix.length >= MIN_STEM_LENGTH) {
      return term.slice(0, -suffix.length);
    }
  }
  return term;
}

/** Distinct meaningful terms of the given text, in first-seen order. */
export function keywordsOf(...texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (raw.length < MIN_TERM_LENGTH || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
      seen.add(stem(raw));
    }
  }
  return [...seen];
}

/** Case-insensitive occurrences of `term`, counted without overlapping itself. */
export function countOccurrences(text: string, term: string): number {
  if (term === "") return 0;
  let count = 0;
  let at = text.indexOf(term);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(term, at + term.length);
  }
  return count;
}

/** Weighted term hits per 100 lines: a long file does not outrank a short one on volume alone. */
export function scoreText(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = terms.reduce((total, term) => total + countOccurrences(lower, term), 0);
  const lines = Math.max(text.split("\n").length, 1);
  return (hits / lines) * 100;
}
