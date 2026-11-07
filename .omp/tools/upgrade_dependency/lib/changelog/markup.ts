// Port of agentmux internal/changelog/markup.go: reduce release-note markdown and HTML to plain text.
// Go decodes entities with html.UnescapeString (the whole HTML5 table); this decodes the numeric
// entities and the common named ones, which is every entity the recorded changelogs carry.

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bull: "\u2022",
  middot: "\u00b7",
  times: "\u00d7",
  divide: "\u00f7",
  plusmn: "\u00b1",
  deg: "\u00b0",
  micro: "\u00b5",
  rarr: "\u2192",
  larr: "\u2190",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  sect: "\u00a7",
  para: "\u00b6",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  sup1: "\u00b9",
  sup2: "\u00b2",
  sup3: "\u00b3",
};

const NUMERIC_ENTITY = /&#(?:[xX]([0-9a-fA-F]+)|(\d+));/g;
const NAMED_ENTITY = /&([a-zA-Z][a-zA-Z0-9]*);/g;

function unescapeHtml(text: string): string {
  return text
    .replace(NUMERIC_ENTITY, (match, hex: string | undefined, dec: string | undefined) => {
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec!, 10);
      return code === 0 || code > 0x10ffff ? match : String.fromCodePoint(code);
    })
    .replace(NAMED_ENTITY, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

const ZERO_WIDTH_SPACE = "\u200b";
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
// codeSpanOrHTMLTag matches an inline code span (kept) or an HTML tag (dropped).
const CODE_SPAN_OR_TAG = /`[^`\n]*`|<[^>]+>/g;

/**
 * StripMarkup reduces release-note markdown and HTML to plain text: links keep their label, images and
 * tags vanish, entities decode, code ticks drop. Renovate PR bodies and GitHub release bodies both pass
 * through it.
 */
export function StripMarkup(s: string): string {
  let text = unescapeHtml(s).replaceAll(ZERO_WIDTH_SPACE, "");
  text = text.replace(MARKDOWN_IMAGE, "");
  for (let next = text.replace(MARKDOWN_LINK, "$1"); next !== text; next = text.replace(MARKDOWN_LINK, "$1")) {
    text = next;
  }
  text = text.replace(CODE_SPAN_OR_TAG, (match) => (match.startsWith("`") ? match : ""));
  return text.replaceAll("`", "");
}
