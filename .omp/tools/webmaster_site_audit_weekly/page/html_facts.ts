/**
 * Pure HTML readers for the page probes: title, meta, headings, links, structured data, analytics tags. Regular
 * expressions over the served HTML, no network and no browser. Ported from `@zysys/site-probes` (`measure-html`,
 * `extract-schema`, `analytics`) so the webmaster CLI and these tools agree on facts.
 */
import type { Heading } from "./measurement.ts";

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m?.[1] ?? "";
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every H1-H6 in document order, including empty-text headings. */
export function extractHeadingOutline(html: string): Heading[] {
  return [...html.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({
    level: Number((m[1] ?? "h0").slice(1)),
    text: stripTags(m[2] ?? ""),
  }));
}

/** Count of heading-level jumps of more than one level, e.g. h2 to h4. */
export function countHeadingLevelSkips(outline: readonly Heading[]): number {
  let prev = 0;
  let skips = 0;
  for (const { level } of outline) {
    if (prev && level > prev + 1) skips += 1;
    prev = level;
  }
  return skips;
}

export interface LinkCounts {
  internalLinks: number;
  externalLinks: number;
}

const ANCHOR_HREF = /<a\b[^>]*href\s*=\s*["'](https?:[^"']+)["']/gi;

const firstGroup = (m: RegExpMatchArray): string[] => (m[1] === undefined ? [] : [m[1]]);
const labelsOf = (tag: string): string[] =>
  [attr(tag, "name"), attr(tag, "property")].map((label) => label.toLowerCase());

/** Counts absolute http(s) `<a href>` anchors by registrable-domain match (the last two hostname labels). */
export function classifyLinks(html: string, finalUrl: string): LinkCounts {
  const regDomain = (hostname: string) => hostname.split(".").slice(-2).join(".");
  const pageDomain = regDomain(new URL(finalUrl).hostname);
  const hrefs = [...html.matchAll(ANCHOR_HREF)].flatMap(firstGroup);
  const isInternal = (href: string) => {
    try {
      return regDomain(new URL(href).hostname) === pageDomain;
    } catch {
      return false;
    }
  };
  const internalLinks = hrefs.filter(isInternal).length;
  return { internalLinks, externalLinks: hrefs.length - internalLinks };
}

export interface ExtractedMeta {
  title: string;
  metaDescription: string;
  canonical: string;
  robots: string;
  openGraph: string[];
  generator: string;
}

/** Title, meta description, canonical, robots, Open Graph property names and generator. */
export function extractMeta(html: string): ExtractedMeta {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaBy = (key: string) => metas.find((t) => labelsOf(t).includes(key)) ?? "";
  const canonical = attr(
    [...html.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .find((t) => attr(t, "rel") === "canonical") ?? "",
    "href",
  );
  const openGraph = [
    ...new Set(metas.map((t) => attr(t, "property").toLowerCase()).filter((p) => p.startsWith("og:"))),
  ].sort();
  return {
    title,
    metaDescription: attr(metaBy("description"), "content"),
    canonical,
    robots: attr(metaBy("robots"), "content"),
    openGraph,
    generator: attr(metaBy("generator"), "content"),
  };
}

export interface ExtractedSchema {
  readonly blocksRendered: number;
  readonly present: string[];
  readonly errors: string[];
}

const LD_JSON_RE = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function hasContext(parsed: unknown): boolean {
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  return roots.every((root) => isRecord(root) && root["@context"] !== undefined);
}

function flattenRoot(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed["@graph"])) return parsed["@graph"];
  return [parsed];
}

function typesOf(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const type = node["@type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

/** Structured-data inventory: every `application/ld+json` block, `@graph` and array roots walked; the types emitted and structural errors. */
export function extractSchema(html: string): ExtractedSchema {
  const errors: string[] = [];
  const nodes: unknown[] = [];
  let blockIndex = 0;
  for (const match of html.matchAll(LD_JSON_RE)) {
    blockIndex += 1;
    const parsed = safeParse(match[1] ?? "");
    if (parsed === undefined) {
      errors.push(`JSON-LD block ${blockIndex} is not valid JSON`);
      continue;
    }
    if (!hasContext(parsed)) errors.push(`JSON-LD block ${blockIndex} has no @context`);
    nodes.push(...flattenRoot(parsed));
  }
  for (const node of nodes) {
    if (typesOf(node).length === 0) errors.push("JSON-LD node has no @type");
  }
  return {
    blocksRendered: nodes.length,
    present: [...new Set(nodes.flatMap(typesOf))].sort((a, b) => a.localeCompare(b)),
    errors,
  };
}

export const ANALYTICS_TAGS = ["ga4", "gtm", "clarity", "site_kit", "jetpack_stats"] as const;
export type AnalyticsTag = (typeof ANALYTICS_TAGS)[number];

const TAG_MARKERS: Readonly<Record<AnalyticsTag, readonly RegExp[]>> = {
  ga4: [/googletagmanager\.com\/gtag\/js\?id=G-/i, /gtag\(\s*['"]config['"]\s*,\s*['"]G-/i],
  gtm: [/googletagmanager\.com\/gtm\.js/i, /\bGTM-[A-Z0-9]+\b/],
  clarity: [/clarity\.ms\/tag\//i],
  site_kit: [/content=["']Site Kit by Google/i],
  jetpack_stats: [/stats\.wp\.com\/e-\d+\.js/i, /\b_stq\b/],
};

/** Which analytics tags the served HTML ships. */
export function detectAnalyticsTags(html: string): AnalyticsTag[] {
  return ANALYTICS_TAGS.filter((tag) => TAG_MARKERS[tag].some((marker) => marker.test(html)));
}
