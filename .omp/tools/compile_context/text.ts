// Go's string semantics, so sizes and keys match agentmux byte for byte.

/** Unicode code points, which is what Go's `utf8.RuneCountInString` counts. */
export function runeCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

// unicode.IsSpace is the Unicode White_Space property (JS `trim` also strips U+FEFF and keeps U+0085).
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Go's `strings.TrimSpace`. */
export function trimSpace(text: string): string {
  return text.replace(EDGE_SPACE, "");
}
