/**
 * What a reader sees, as letters and digits, copied from the Mastra factory's `write_ticket_and_read_back.ts`. Linear
 * normalises what it stores: it rewrites a link as `[label](<url>)`, escapes characters, trims blanks, and expands a
 * plain-text issue mention into the self-closing `<issue id="<uuid>" label="ZYS-123" href="…"/>` or keeps a reference the
 * writer already tagged as `<issue id="<uuid>" href="…">ZYS-123</issue>`. It also expands a bare `#342` that matches a
 * workspace pull request into `<pull-request id="<uuid>" href="…">org/repo#342</pull-request>`. A single-line
 * `<tag …>label</tag>` keeps only its label (requiring whitespace or `>` after the tag name so placeholders like
 * `<issue|pr>` are never read as opening `<issue>` tags), a single-line `<tag … label="label" …/>` keeps that label
 * attribute — the mention chip a reader sees — `org/repo#123` is normalised to `#123` so a pull-request auto-link matches
 * the `#123` that was written, and markdown link targets are dropped without a multiline `<[^>]*>` sweep that would eat
 * between a `<` in code and a later `>`.
 */
export function readerWords(text: string): string {
  return text
    .replace(/<([A-Za-z][\w-]*)((?:\s[^>\n]*?)?)\s*\/>/g, (_tag, _name: string, attrs: string) =>
      /(?:^|\s)label="([^"]*)"/.exec(attrs)?.[1] ?? "")
    .replace(/<([A-Za-z][\w-]*)(?:\s[^>\n]*)?>([^<\n]*?)<\/\1>/g, "$2")
    .replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)\b/g, "#$1")
    .replace(/\]\(\s*<[^>\n]*>\s*\)|\]\([^)\n]*\)/g, "]")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a stored body is the body that was written, by what a reader sees of each. */
export function sameWords(left: string, right: string): boolean {
  return readerWords(left) === readerWords(right);
}
