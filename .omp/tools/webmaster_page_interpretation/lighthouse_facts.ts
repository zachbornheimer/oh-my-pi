import { OPPORTUNITY_IMPACTS, type OpportunityImpact, type PerformanceMetrics, type PerformanceOpportunity } from "./measurement.ts";

/** An audit fails, and so may be an opportunity, below this score. */
const PASSING_SCORE = 0.9;
const OPPORTUNITY_CAP = 10;

/** The Lighthouse audits reported as opportunities, and the metrics fixing each one improves. */
const AUDIT_IMPACTS: Readonly<Record<string, readonly OpportunityImpact[]>> = {
  "unused-javascript": ["LCP", "FCP", "INP"],
  "unused-css-rules": ["LCP", "FCP"],
  "render-blocking-resources": ["LCP", "FCP"],
  "unminified-javascript": ["LCP", "FCP"],
  "unminified-css": ["LCP", "FCP"],
  "unsized-images": ["CLS"],
  "non-composited-animations": ["CLS"],
  "uses-text-compression": ["LCP", "FCP"],
  "uses-responsive-images": ["LCP"],
  "uses-optimized-images": ["LCP"],
  "modern-image-formats": ["LCP"],
  "efficient-animated-content": ["LCP"],
  "font-display": ["LCP", "FCP"],
  "server-response-time": ["TTFB", "FCP", "LCP"],
};

/**
 * The Lighthouse insight audits reported as opportunities, each with the audits it replaced. Lighthouse 13 dropped
 * those audits; older reports carry both, so an insight is skipped when any audit it replaced is in the report and one
 * problem is never counted twice. `server-response-time` survives in 13, so it does not suppress document latency.
 */
const INSIGHT_REPLACES: Readonly<Record<string, readonly string[]>> = {
  "render-blocking-insight": ["render-blocking-resources"],
  "font-display-insight": ["font-display"],
  "image-delivery-insight": [
    "uses-responsive-images",
    "uses-optimized-images",
    "modern-image-formats",
    "efficient-animated-content",
  ],
  "document-latency-insight": ["uses-text-compression"],
  "duplicated-javascript-insight": [],
  "legacy-javascript-insight": [],
  "lcp-discovery-insight": [],
  "cache-insight": [],
  "cls-culprits-insight": [],
  "modern-http-insight": [],
};

/** The `metricSavings` keys measured in milliseconds; CLS is unitless. */
const TIMING_METRICS: Readonly<Record<string, true>> = { FCP: true, LCP: true, INP: true, TBT: true };

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** True when `value` is absent or passes `ok`; the shape of an optional field. */
const absentOr = <T>(value: unknown, ok: (candidate: unknown) => candidate is T): value is T | undefined =>
  value === undefined || ok(value);

interface Audit {
  score?: number | null;
  numericValue?: number;
  title?: string;
  description?: string;
  details?: {
    items?: unknown[];
    overallSavingsBytes?: number;
    overallSavingsMs?: number;
    debugData?: { wastedBytes?: number } | null;
  };
  metricSavings?: Json;
}

/** One audit of a Lighthouse result, or undefined when it is absent or a field has the wrong type. */
function readAudit(raw: unknown): Audit | undefined {
  if (!isJson(raw)) return undefined;
  const { score, numericValue, title, description, details, metricSavings } = raw;
  if (!(score === null || absentOr(score, isNumber))) return undefined;
  if (!absentOr(numericValue, isNumber) || !absentOr(title, isString) || !absentOr(description, isString)) {
    return undefined;
  }
  if (details !== undefined && !isJson(details)) return undefined;
  const audit: Audit = {
    ...(score === undefined ? {} : { score: score as number | null }),
    ...(numericValue === undefined ? {} : { numericValue }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(isJson(metricSavings) ? { metricSavings } : {}),
  };
  if (details !== undefined) {
    const { items, overallSavingsBytes, overallSavingsMs, debugData } = details;
    if (!absentOr(overallSavingsBytes, isNumber) || !absentOr(overallSavingsMs, isNumber)) return undefined;
    // Insight checklists carry an object where a list of items is expected, so a non-list is no items rather than a failure.
    const wasted = isJson(debugData) && absentOr(debugData["wastedBytes"], isNumber)
      ? { wastedBytes: debugData["wastedBytes"] as number | undefined }
      : undefined;
    audit.details = {
      ...(Array.isArray(items) ? { items } : {}),
      ...(overallSavingsBytes === undefined ? {} : { overallSavingsBytes }),
      ...(overallSavingsMs === undefined ? {} : { overallSavingsMs }),
      ...(wasted === undefined ? {} : { debugData: wasted.wastedBytes === undefined ? {} : { wastedBytes: wasted.wastedBytes } }),
    };
  }
  return audit;
}

interface ResourceItem {
  resourceType?: string;
  label?: string;
  requestCount?: number;
  transferSize?: number;
}
interface RequestItem {
  url: string;
  resourceType?: string;
  transferSize?: number;
}
interface LibraryItem {
  name: string;
  version?: string | null;
}

const asResource = (item: unknown): ResourceItem | undefined =>
  isJson(item) && absentOr(item["resourceType"], isString) && absentOr(item["label"], isString)
    && absentOr(item["requestCount"], isNumber) && absentOr(item["transferSize"], isNumber)
    ? item as ResourceItem
    : undefined;

const asRequest = (item: unknown): RequestItem | undefined =>
  isJson(item) && isString(item["url"]) && absentOr(item["resourceType"], isString) && absentOr(item["transferSize"], isNumber)
    ? item as unknown as RequestItem
    : undefined;

const asLibrary = (item: unknown): LibraryItem | undefined =>
  isJson(item) && isString(item["name"]) && (item["version"] === null || absentOr(item["version"], isString))
    ? item as unknown as LibraryItem
    : undefined;

/** The items of an audit that fit `read`; an item of another shape is skipped, not fatal. */
function itemsOf<T>(audit: Audit | undefined, read: (item: unknown) => T | undefined): T[] | undefined {
  const items = audit?.details?.items;
  if (items === undefined) return undefined;
  return items.flatMap((item) => {
    const parsed = read(item);
    return parsed === undefined ? [] : [parsed];
  });
}

const ms = (value: number | undefined): number | null => value === undefined ? null : Math.round(value);

const bytes = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && value > 0 ? Math.round(value) : undefined;

/** A host compared as the same site whether or not it has a leading `www.`. */
const siteHost = (hostname: string): string => hostname.toLowerCase().replace(/^www\./, "");

/** The host of an http(s) request; undefined for data:, blob: and unparsable addresses. */
function webHost(address: string): string | undefined {
  try {
    const parsed = new URL(address);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function thirdParty(requests: readonly RequestItem[], finalUrl: string): PerformanceMetrics["third_party"] {
  const own = siteHost(new URL(finalUrl).hostname);
  const foreign = requests.flatMap((request) => {
    const host = webHost(request.url);
    return host === undefined || siteHost(host) === own ? [] : [{ host, size: request.transferSize ?? 0 }];
  });
  return {
    requests: foreign.length,
    transfer_bytes: foreign.reduce((sum, request) => sum + request.size, 0),
    domains: [...new Set(foreign.map((request) => request.host))].sort(),
  };
}

function largestImage(requests: readonly RequestItem[]): PerformanceMetrics["largest_image"] {
  const images = requests.filter((request) => request.resourceType === "Image");
  if (images.length === 0) return null;
  const largest = images.reduce((best, image) => (image.transferSize ?? 0) > (best.transferSize ?? 0) ? image : best);
  return { url: largest.url, transfer_bytes: largest.transferSize ?? 0 };
}

function opportunityOf(id: string, audit: Audit | undefined): PerformanceOpportunity[] {
  const impacts = AUDIT_IMPACTS[id];
  if (impacts === undefined || audit === undefined) return [];
  if (typeof audit.score !== "number" || audit.score >= PASSING_SCORE) return [];
  const savingsMs = positive(audit.numericValue) ?? positive(audit.details?.overallSavingsMs);
  const savingsBytes = positive(audit.details?.overallSavingsBytes);
  if (savingsMs === undefined && savingsBytes === undefined) return [];
  return [{
    audit: id,
    title: audit.title ?? id,
    ...(audit.description === undefined ? {} : { description: audit.description }),
    ...(savingsMs === undefined ? {} : { savings_ms: savingsMs }),
    ...(savingsBytes === undefined ? {} : { savings_bytes: savingsBytes }),
    impacts: [...impacts],
  }];
}

/**
 * An insight audit as an opportunity when it fails and quantifies a saving: its largest timing saving, its wasted
 * bytes, or a positive (unitless) CLS saving. It impacts each metric its `metricSavings` gives a positive value.
 */
function insightOf(id: string, audit: Audit | undefined): PerformanceOpportunity[] {
  if (audit === undefined || typeof audit.score !== "number" || audit.score >= PASSING_SCORE) return [];
  const saved = Object.entries(audit.metricSavings ?? {}).flatMap(([metric, value]) =>
    typeof value === "number" && value > 0 ? [{ metric, value }] : []
  );
  const timing = saved.filter((s) => TIMING_METRICS[s.metric] === true).map((s) => s.value);
  const savingsMs = positive(Math.max(0, ...timing));
  const savingsBytes = positive(audit.details?.debugData?.wastedBytes);
  const impacts = OPPORTUNITY_IMPACTS.filter((impact) => saved.some((s) => s.metric === impact));
  if (savingsMs === undefined && savingsBytes === undefined && !impacts.includes("CLS")) return [];
  return [{
    audit: id,
    title: audit.title ?? id,
    ...(audit.description === undefined ? {} : { description: audit.description }),
    ...(savingsMs === undefined ? {} : { savings_ms: savingsMs }),
    ...(savingsBytes === undefined ? {} : { savings_bytes: savingsBytes }),
    impacts: [...impacts],
  }];
}

/**
 * The performance facts of one Lighthouse result (`{ categories, audits }`), from PageSpeed or a local run alike, so
 * both sources report the same facts. `finalUrl` is the page, to tell its own requests from third parties. A missing
 * audit is null (an empty list for lists), never zero. `inp_ms` is the lab figure; PageSpeed replaces it with CrUX's.
 * Throws when the result has no performance category.
 */
export function lighthouseFacts(lighthouseResult: unknown, finalUrl: string): PerformanceMetrics {
  if (!isJson(lighthouseResult)) throw new Error("the Lighthouse result is not an object");
  const { categories, audits } = lighthouseResult;
  const category = isJson(categories) ? categories["performance"] : undefined;
  const score = isJson(category) ? category["score"] : undefined;
  if (!(score === null || isNumber(score))) throw new Error("the Lighthouse result has no performance category score");
  if (!isJson(audits)) throw new Error("the Lighthouse result has no audits");
  const audit = (id: string): Audit | undefined => readAudit(audits[id]);
  const resources = itemsOf(audit("resource-summary"), asResource);
  const requests = itemsOf(audit("network-requests"), asRequest);
  const blocking = audit("render-blocking-resources") ?? audit("render-blocking-insight");
  return {
    ttfb_ms: ms(audit("server-response-time")?.numericValue),
    lcp_ms: ms(audit("largest-contentful-paint")?.numericValue),
    fcp_ms: ms(audit("first-contentful-paint")?.numericValue),
    inp_ms: ms(audit("interaction-to-next-paint")?.numericValue),
    si_ms: ms(audit("speed-index")?.numericValue),
    tbt_ms: ms(audit("total-blocking-time")?.numericValue),
    cls: audit("cumulative-layout-shift")?.numericValue ?? null,
    perf_score: score,
    weight_bytes: audit("total-byte-weight")?.numericValue ?? null,
    image_count: resources?.find((item) => item.resourceType === "image")?.requestCount ?? null,
    resource_summary: resources?.map((item) => ({
      type: item.resourceType ?? item.label ?? "unknown",
      requests: item.requestCount ?? 0,
      transfer_bytes: item.transferSize ?? 0,
    })) ?? null,
    unused_css_bytes: bytes(audit("unused-css-rules")?.details?.overallSavingsBytes),
    unused_js_bytes: bytes(audit("unused-javascript")?.details?.overallSavingsBytes),
    largest_image: requests === undefined ? null : largestImage(requests),
    render_blocking_count: blocking === undefined ? null : blocking.details?.items?.length ?? 0,
    frameworks: (itemsOf(audit("js-libraries"), asLibrary) ?? [])
      .map((library) => library.version ? `${library.name} ${library.version}` : library.name),
    third_party: requests === undefined ? null : thirdParty(requests, finalUrl),
    opportunities: [
      ...Object.keys(AUDIT_IMPACTS).flatMap((id) => opportunityOf(id, audit(id))),
      ...Object.entries(INSIGHT_REPLACES)
        .filter(([, replaced]) => !replaced.some((legacy) => legacy in audits))
        .flatMap(([id]) => insightOf(id, audit(id))),
    ]
      .sort((a, b) => (b.savings_ms ?? 0) - (a.savings_ms ?? 0) || (b.savings_bytes ?? 0) - (a.savings_bytes ?? 0))
      .slice(0, OPPORTUNITY_CAP),
  };
}
