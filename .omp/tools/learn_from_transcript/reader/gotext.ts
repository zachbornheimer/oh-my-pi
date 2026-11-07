// The one Go string function the transcript readers depend on.

// unicode.IsSpace is the Unicode White_Space property (JS `trim` also strips U+FEFF and keeps U+0085).
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Go's `strings.TrimSpace`. */
export function trimSpace(text: string): string {
  return text.replace(EDGE_SPACE, "");
}
