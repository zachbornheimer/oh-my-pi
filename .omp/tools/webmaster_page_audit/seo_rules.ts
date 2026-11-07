import type { Finding } from "./finding.ts";
import type { SeoMeasurement } from "./measurement.ts";

type Measured = Extract<SeoMeasurement, { status: "measured" }>;

/** What the SEO tool reports as the page's search facts. */
export interface SeoFacts {
  title: string;
  meta_description: string;
  canonical: string;
  h1_count: number;
  heading_outline: string[];
  schema_types: string[];
  og: string[];
  link_counts: { internal: number; external: number };
  robots: string;
  indexable: boolean;
}

export const TITLE_MIN_CHARS = 30;
export const TITLE_MAX_CHARS = 60;
export const DESCRIPTION_MIN_CHARS = 70;
export const DESCRIPTION_MAX_CHARS = 160;
const NOINDEX = /noindex/i;
const OUTLINE_TEXT_CHARS = 80;
const EXAMPLES_SHOWN = 3;

export const isIndexable = (page: Measured): boolean => !NOINDEX.test(`${page.robots_meta} ${page.x_robots_tag}`);

/** The page as facts: what the probe read, in the shape a person (and the audit) reads it. */
export function seoFacts(page: Measured): SeoFacts {
  return {
    title: page.title,
    meta_description: page.meta_description,
    canonical: page.canonical,
    h1_count: page.headings.filter((heading) => heading.level === 1).length,
    heading_outline: page.headings.map((heading) => `h${heading.level}: ${heading.text.slice(0, OUTLINE_TEXT_CHARS)}`),
    schema_types: page.schema_types,
    og: page.open_graph,
    link_counts: { internal: page.internal_links, external: page.external_links },
    robots: [page.robots_meta, page.x_robots_tag].filter((part) => part !== "").join("; "),
    indexable: isIndexable(page),
  };
}

const finding = (
  id: string,
  severity: Finding["severity"],
  evidence: string,
  fix_hint: string,
): Finding => ({ id: `seo.${id}`, area: "seo", severity, evidence, fix_hint });

function titleFindings(title: string): Finding[] {
  if (title === "") {
    return [
      finding(
        "title_missing",
        "high",
        "The page has no <title>.",
        "Add a unique title of 30 to 60 characters that names the page.",
      ),
    ];
  }
  if (title.length < TITLE_MIN_CHARS || title.length > TITLE_MAX_CHARS) {
    return [
      finding(
        "title_length",
        "low",
        `The title is ${title.length} characters: "${title}". Search shows about ${TITLE_MAX_CHARS}.`,
        `Rewrite the title to ${TITLE_MIN_CHARS} to ${TITLE_MAX_CHARS} characters.`,
      ),
    ];
  }
  return [];
}

function descriptionFindings(description: string): Finding[] {
  if (description === "") {
    return [
      finding(
        "meta_description_missing",
        "medium",
        "The page has no meta description.",
        "Add a meta description of 70 to 160 characters that sells the click.",
      ),
    ];
  }
  if (description.length < DESCRIPTION_MIN_CHARS || description.length > DESCRIPTION_MAX_CHARS) {
    return [
      finding(
        "meta_description_length",
        "low",
        `The meta description is ${description.length} characters. Search shows about ${DESCRIPTION_MAX_CHARS}.`,
        `Rewrite it to ${DESCRIPTION_MIN_CHARS} to ${DESCRIPTION_MAX_CHARS} characters.`,
      ),
    ];
  }
  return [];
}

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

function canonicalFindings(page: Measured): Finding[] {
  if (page.canonical === "") {
    return [
      finding(
        "canonical_missing",
        "medium",
        "The page declares no canonical URL.",
        "Add <link rel=\"canonical\"> pointing at this page's preferred address.",
      ),
    ];
  }
  const canonical = new URL(page.canonical, page.final_url);
  const final = new URL(page.final_url);
  const sameAddress = canonical.host === final.host
    && withoutTrailingSlash(canonical.pathname) === withoutTrailingSlash(final.pathname);
  if (sameAddress) return [];
  return [
    finding(
      "canonical_elsewhere",
      "medium",
      `The page at ${page.final_url} names ${canonical.toString()} as canonical.`,
      "Point the canonical at this page, or confirm the page is meant to defer to the other address.",
    ),
  ];
}

function headingFindings(page: Measured, h1Count: number): Finding[] {
  const found: Finding[] = [];
  if (h1Count === 0) {
    found.push(
      finding(
        "h1_missing",
        "medium",
        "The page has no <h1>.",
        "Give the page exactly one <h1> that states what it is about.",
      ),
    );
  }
  if (h1Count > 1) {
    found.push(
      finding(
        "h1_multiple",
        "low",
        `The page has ${h1Count} <h1> headings.`,
        "Keep one <h1>; demote the others to <h2>.",
      ),
    );
  }
  if (page.heading_level_skips > 0) {
    found.push(
      finding(
        "heading_level_skips",
        "low",
        `The heading outline skips a level ${page.heading_level_skips} time(s), such as h2 to h4.`,
        "Nest headings one level at a time.",
      ),
    );
  }
  return found;
}

function structuredDataFindings(page: Measured): Finding[] {
  const found: Finding[] = [];
  if (page.schema_types.length === 0) {
    found.push(
      finding(
        "schema_missing",
        "medium",
        "The page emits no schema.org structured data.",
        "Add JSON-LD for the page's kind (Organization and WebSite on the home page).",
      ),
    );
  }
  if (page.schema_errors.length > 0) {
    found.push(
      finding(
        "schema_errors",
        "medium",
        `Structured data has errors: ${page.schema_errors.slice(0, EXAMPLES_SHOWN).join("; ")}.`,
        "Fix the JSON-LD so each block parses and each node has an @type and @context.",
      ),
    );
  }
  if (page.open_graph.length === 0) {
    found.push(
      finding(
        "open_graph_missing",
        "low",
        "The page has no Open Graph tags.",
        "Add og:title, og:description and og:image so shares look right.",
      ),
    );
  }
  return found;
}

/** Every SEO finding a rule can raise from one measured page. Pure: the same page always gives the same findings. */
export function seoFindings(page: Measured): Finding[] {
  const noindex = isIndexable(page)
    ? []
    : [
      finding(
        "noindex",
        "high",
        `The page tells search not to index it (${[page.robots_meta, page.x_robots_tag].filter(Boolean).join("; ")}).`,
        "Remove noindex unless the page is meant to stay out of search.",
      ),
    ];
  const h1Count = page.headings.filter((heading) => heading.level === 1).length;
  return [
    ...noindex,
    ...titleFindings(page.title),
    ...descriptionFindings(page.meta_description),
    ...canonicalFindings(page),
    ...headingFindings(page, h1Count),
    ...structuredDataFindings(page),
  ];
}
