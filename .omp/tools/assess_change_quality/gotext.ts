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

/** The decimal exponents between which Go's shortest `%g` stays out of scientific notation. */
const SCIENTIFIC_FROM = 6;
const SCIENTIFIC_BELOW = -4;
const EXPONENT_WIDTH = 2;

/** Go's `%g` for a float64: the shortest digits that round-trip, scientific only outside 1e-4..1e6. */
export function formatFloat(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < SCIENTIFIC_BELOW || exponent >= SCIENTIFIC_FROM) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const exponentSign = exponent < 0 ? "-" : "+";
    return `${sign}${digits[0]}${fraction}e${exponentSign}${String(Math.abs(exponent)).padStart(EXPONENT_WIDTH, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Go's `strings.Compare`: by UTF-8 bytes (the default JS sort uses UTF-16 units and disagrees outside ASCII). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// unicode.IsSpace is the Unicode White_Space property (JS `trim` also strips U+FEFF and keeps U+0085).
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Go's `strings.TrimSpace`. */
export function trimSpace(text: string): string {
  return text.replace(EDGE_SPACE, "");
}

/** The byte length of `text` in UTF-8, which is what Go's `len` counts. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8 without splitting a character. */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString("utf8");
}
