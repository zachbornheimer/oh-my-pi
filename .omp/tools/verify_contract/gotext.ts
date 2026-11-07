// Go string and number formatting that capability output depends on, so text and ordering match agentmux byte for byte.

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
  "\\": "\\\\",
  "\"": "\\\"",
};

// strconv.IsPrint: letters, marks, numbers, punctuation, symbols and the ASCII space.
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

const ASCII_LIMIT = 0x80;
const BASIC_PLANE_LIMIT = 0x10000;

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).padStart(width, "0");
}

function quoteRune(rune: string): string {
  const short = SHORT_ESCAPES[rune];
  if (short !== undefined) return short;
  if (PRINTABLE.test(rune)) return rune;
  const codePoint = rune.codePointAt(0) ?? 0;
  if (codePoint < ASCII_LIMIT) return `\\x${hex(codePoint, 2)}`;
  return codePoint < BASIC_PLANE_LIMIT ? `\\u${hex(codePoint, 4)}` : `\\U${hex(codePoint, 8)}`;
}

/** Go's `%q` for a string (`strconv.Quote`). */
export function quote(text: string): string {
  return `"${Array.from(text, quoteRune).join("")}"`;
}
