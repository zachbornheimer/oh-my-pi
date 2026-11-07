import type { Analog, AuditFinding, PagePurpose } from "./schemas.ts";
import type {
  ContentMeasurement,
  PerformanceMeasurement,
  PerformanceOpportunity,
  SeoMeasurement,
} from "./measurement.ts";
import { describeSite, type SiteContext } from "./site_context.ts";
/** The measurements the page-audit judgment stages read, by area; each is optional and may be unmeasured. */
export interface MeasuredAreas {
  readonly seo?: SeoMeasurement;
  readonly performance?: PerformanceMeasurement;
  readonly content?: ContentMeasurement;
}

const line = (label: string, value: string): string => `- ${label}: ${value}`;

const ms = (value: number | null): string => value === null ? "not measured" : `${Math.round(value)} ms`;

const kb = (value: number | null): string => value === null ? "not measured" : `${Math.round(value / 1024)} KB`;

function opportunityLine(opportunity: PerformanceOpportunity): string {
  const savings = [
    opportunity.savings_ms === undefined ? undefined : `${opportunity.savings_ms} ms`,
    opportunity.savings_bytes === undefined ? undefined : kb(opportunity.savings_bytes),
  ].filter((saving) => saving !== undefined);
  return line(
    "Opportunity",
    `${opportunity.title} (${opportunity.audit}): saves ${savings.join(", ")}; improves ${
      opportunity.impacts.join(", ")
    }`,
  );
}

function seoLines(page: Extract<SeoMeasurement, { status: "measured" }>): string[] {
  return [
    line("Final URL", page.final_url),
    line("HTTP status", String(page.http_status)),
    line("Title", page.title),
    line("Meta description", page.meta_description),
    line("Canonical", page.canonical === "" ? "none" : page.canonical),
    line("Robots meta", page.robots_meta === "" ? "none" : page.robots_meta),
    line("X-Robots-Tag", page.x_robots_tag === "" ? "none" : page.x_robots_tag),
    line("Headings", page.headings.map((heading) => `h${heading.level} "${heading.text}"`).join(", ")),
    line("Heading level skips", String(page.heading_level_skips)),
    line("Schema types", page.schema_types.join(", ") || "none"),
    line("Schema errors", page.schema_errors.join(", ") || "none"),
    line("Open Graph", page.open_graph.join(", ") || "none"),
    line("Links", `${page.internal_links} internal, ${page.external_links} external`),
  ];
}

function performanceLines(page: Extract<PerformanceMeasurement, { status: "measured" }>): string[] {
  const { metrics } = page;
  return [
    line("Source", `${page.source} (${page.form_factor})`),
    line("TTFB", ms(metrics.ttfb_ms)),
    line("LCP", ms(metrics.lcp_ms)),
    line("FCP", ms(metrics.fcp_ms)),
    line("INP", ms(metrics.inp_ms)),
    line("Speed Index", ms(metrics.si_ms)),
    line("TBT", ms(metrics.tbt_ms)),
    line("CLS", metrics.cls === null ? "not measured" : String(metrics.cls)),
    line(
      "Performance score",
      metrics.perf_score === null ? "not measured" : `${Math.round(metrics.perf_score * 100)}/100`,
    ),
    line("Page weight", kb(metrics.weight_bytes)),
    line("Images requested", metrics.image_count === null ? "not measured" : String(metrics.image_count)),
    line(
      "Requests by type",
      metrics.resource_summary === null
        ? "not measured"
        : metrics.resource_summary.map((type) => `${type.type} ${type.requests} (${kb(type.transfer_bytes)})`)
          .join(", ") || "none",
    ),
    line(
      "Third-party requests",
      metrics.third_party === null
        ? "not measured"
        : `${metrics.third_party.requests} (${kb(metrics.third_party.transfer_bytes)}) from ${
          metrics.third_party.domains.join(", ") || "no other host"
        }`,
    ),
    line("Unused CSS", kb(metrics.unused_css_bytes)),
    line("Unused JavaScript", kb(metrics.unused_js_bytes)),
    line(
      "Largest image",
      metrics.largest_image === null
        ? "not measured"
        : `${metrics.largest_image.url} (${kb(metrics.largest_image.transfer_bytes)})`,
    ),
    line(
      "Render-blocking resources",
      metrics.render_blocking_count === null ? "not measured" : String(metrics.render_blocking_count),
    ),
    line("JavaScript frameworks", metrics.frameworks.join(", ") || "none detected"),
    ...(metrics.opportunities.length === 0
      ? [line("Opportunities", "none")]
      : metrics.opportunities.map(opportunityLine)),
  ];
}

/** The content probe's facts; `textCap` quotes only the start of the visible text, for a brief over many pages. */
function contentLines(page: Extract<ContentMeasurement, { status: "measured" }>, textCap?: number): string[] {
  const text = textCap === undefined || page.visible_text.length <= textCap
    ? page.visible_text
    : `${page.visible_text.slice(0, textCap)}…`;
  return [
    line("Final URL", page.final_url),
    line("HTTP status", String(page.http_status)),
    line("Visible text", `"${text}"`),
    line("Analytics tags", page.tag_ids.join(", ") || "none"),
    line("Facebook pixel", page.fb_pixel ? "present" : "absent"),
    line("Third-party domains", page.third_party_domains.join(", ") || "none"),
    line("Images", `${page.image_count_dom} in the DOM, ${page.images_missing_alt} without alt text`),
    line("Generator", page.generator === "" ? "none" : page.generator),
  ];
}

/** One area of the ground truth: its labeled facts, or the one line saying why there are none. */
const area = (name: string, facts: readonly string[] | string): string =>
  [`### ${name}`, ...(Array.isArray(facts) ? facts : [`- ${facts}`])].join("\n");

const seoGround = (page: SeoMeasurement | undefined): readonly string[] | string =>
  page === undefined
    ? "not measured for this run"
    : page.status === "unmeasured"
    ? `unmeasured: ${page.reason}`
    : seoLines(page);

const performanceGround = (page: PerformanceMeasurement | undefined): readonly string[] | string =>
  page === undefined
    ? "not measured for this run"
    : page.status === "unmeasured"
    ? `unmeasured: ${page.reason}`
    : performanceLines(page);

const contentGround = (page: ContentMeasurement | undefined): readonly string[] | string =>
  page === undefined
    ? "not measured for this run"
    : page.status === "unmeasured"
    ? `unmeasured: ${page.reason}`
    : contentLines(page);

/**
 * The measured ground truth a judgment stage reads: target, site and every measurement's facts or its
 * unmeasured reason. Labeled text, the same convention zwsip's audit script prints.
 */
export function measuredGroundTruth(scene: {
  readonly url: string;
  readonly site?: SiteContext;
  readonly measurements?: MeasuredAreas;
}): string {
  const measured = scene.measurements ?? {};
  return [
    `Target URL: ${scene.url}`,
    `Site: ${describeSite(scene.site)}`,
    "",
    "## Measured ground truth",
    "",
    area("SEO", seoGround(measured.seo)),
    area("Performance", performanceGround(measured.performance)),
    area("Content", contentGround(measured.content)),
  ].join("\n");
}

/** The purpose judgment as labeled lines, the stage above the ground truth it was read from. */
export function purposeGround(purpose: PagePurpose): string[] {
  return [
    line("Purpose", purpose.purpose),
    line("Intent class", purpose.intentClass),
    line("Primary audience", purpose.primaryAudience),
    line("Primary action", purpose.primaryAction ?? "none evident"),
    ...purpose.evidence.map((quote, index) => line(`Purpose evidence ${index + 1}`, quote)),
  ];
}

/** The interpretation findings as labeled lines, each a measured fact and what it means for the page. */
export function interpretationGround(findings: readonly AuditFinding[]): string[] {
  return findings.length === 0
    ? [line("Interpretation findings", "none")]
    : findings.map((finding, index) =>
      line(`Interpretation finding ${index + 1}`, `${finding.measurement}: ${finding.consequence}`)
    );
}

/** The most characters of one page's visible text a brief over many pages quotes. */
const MANY_PAGES_TEXT_CAP = 600;

/** A page both probes read, as a candidate brief shows it. */
export interface FetchedPageBrief {
  readonly url: string;
  readonly snippet: string;
  readonly seo: Extract<SeoMeasurement, { status: "measured" }>;
  readonly content: Extract<ContentMeasurement, { status: "measured" }>;
}

/** Every page the analog search fetched, numbered from 1: its address, search snippet, search facts and text excerpt. */
export function candidatesGround(pages: readonly FetchedPageBrief[]): string {
  return pages.map((page, index) =>
    [
      `### Candidate ${index + 1}`,
      line("URL", page.url),
      line("Search snippet", page.snippet === "" ? "none" : page.snippet),
      ...seoLines(page.seo),
      ...contentLines(page.content, MANY_PAGES_TEXT_CAP),
    ].join("\n")
  ).join("\n\n");
}

/** An analog's speed in the few numbers a comparison needs, or why it was not measured. */
function performanceSummary(page: PerformanceMeasurement): string {
  if (page.status === "unmeasured") return `unmeasured: ${page.reason}`;
  const { metrics } = page;
  const score = metrics.perf_score === null ? "not measured" : `${Math.round(metrics.perf_score * 100)}/100`;
  return `LCP ${ms(metrics.lcp_ms)}, TBT ${ms(metrics.tbt_ms)}, CLS ${
    metrics.cls === null ? "not measured" : String(metrics.cls)
  }, score ${score}, weight ${kb(metrics.weight_bytes)} (${page.source}, ${page.form_factor})`;
}

/**
 * The REMOTE layer a synthesis reads: each analog by its zero-based index into the combined list (same industry
 * first), with who publishes it, why it is analogous, its standout pattern and the key facts its fetch measured.
 */
export function analogsGround(analogs: readonly Analog[]): string {
  if (analogs.length === 0) return "No analogs were supplied.";
  return analogs.map((analog, index) => {
    const { seo, content, performance } = analog.measurements;
    return [
      `### Analog ${index}: ${analog.organization}`,
      line("URL", analog.url),
      line("Industry", analog.industry),
      line("Observed title", analog.observedTitle),
      line("Why analogous", analog.whyAnalogous),
      line("Standout pattern", analog.standoutPattern),
      ...(seo.status === "measured" ? seoLines(seo) : [line("SEO", `unmeasured: ${seo.reason}`)]),
      ...(content.status === "measured"
        ? contentLines(content, MANY_PAGES_TEXT_CAP)
        : [line("Content", `unmeasured: ${content.reason}`)]),
      line("Performance", performanceSummary(performance)),
    ].join("\n");
  }).join("\n\n");
}
