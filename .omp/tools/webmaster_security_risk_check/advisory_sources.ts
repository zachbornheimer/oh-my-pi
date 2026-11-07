import { publicGet } from "./net.ts";
import { resolveProviders, searchWith, type WebSearchResult } from "./providers.ts";
import type { AdvisorySource } from "./types.ts";

/**
 * Reading what the owner's words point at: the pages and domains they name, the CVE records they cite (NVD and OSV),
 * or, when they name nothing to read, what a web search of their words finds. Plumbing for the host: it reads and keeps
 * text, and decides nothing about what the advisory means.
 */

export const MAX_PAGES = 4;
/** CVE records read for one advisory: those the owner names first, then those a fetched article names. */
export const MAX_CVES = 5;
export const MAX_SEARCH_PAGES = 3;
const TEXT_CAP = 24_000;
/** A distro tracker is already one line per package or release: room for the whole of one (Ubuntu's page for a kernel CVE is about 8,000). */
const DISTRO_CAP = 12_000;
const FETCH_CAP = 400_000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "capability-replicas-webmaster-security/1.0 (+read-only advisory research)";
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
/** The last label of a word that looks like a domain but names a file or a language. */
const NOT_A_DOMAIN = new Set([
  "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "md", "json", "yaml", "yml", "txt", "conf", "cfg", "ini", "sh",
  "php", "html", "css", "so", "dll", "exe", "log", "lock", "toml", "sql", "cpp", "java", "xml", "csv", "pdf", "png",
  "jpg", "svg", "gz", "zip", "tar",
]);

export interface Targets {
  readonly urls: string[];
  readonly cves: string[];
}

/** The addresses and CVE ids in the owner's words; a bare domain becomes its home page. */
export function targetsIn(text: string): Targets {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map((match) => match[0].replace(TRAILING_PUNCTUATION, ""));
  const rest = text.replace(/https?:\/\/[^\s<>"'`]+/gi, " ");
  const domains = [...rest.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi)]
    .map((match) => match[0].toLowerCase())
    .filter((domain) => !NOT_A_DOMAIN.has(domain.split(".").pop() ?? ""))
    .map((domain) => `https://${domain}/`);
  const cves = [...text.matchAll(/CVE-\d{4}-\d{4,}/gi)].map((match) => match[0].toUpperCase());
  return { urls: [...new Set([...urls, ...domains])], cves: [...new Set(cves)] };
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  middot: "·",
  rarr: "→",
  larr: "←",
};

/** A page's readable text: no scripts, styles or tags, entities decoded, blank runs collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|section|article|pre|tr|table|blockquote|figure|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => typeof value === "object" && value !== null ? value as Json : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asText = (value: unknown): string => typeof value === "string" ? value : "";

/** A CVE record from NVD as the lines a reader needs: what it says, how bad, which products and versions, where to read more. */
export function nvdText(body: string): string {
  const record = asObject(asObject(asArray(asObject(JSON.parse(body)).vulnerabilities)[0]).cve);
  const lines = [asText(record.id)];
  const english = asArray(record.descriptions).map(asObject).find((entry) => entry.lang === "en");
  if (english !== undefined) lines.push(asText(english.value));
  const metric = asObject(asArray(asObject(record.metrics).cvssMetricV31)[0] ?? asArray(asObject(record.metrics).cvssMetricV40)[0]);
  const cvss = asObject(metric.cvssData);
  if (cvss.baseScore !== undefined) lines.push(`CVSS ${String(cvss.baseScore)} ${asText(cvss.baseSeverity)} ${asText(cvss.vectorString)}`);
  for (const configuration of asArray(record.configurations).map(asObject)) {
    for (const node of asArray(configuration.nodes).map(asObject)) {
      for (const match of asArray(node.cpeMatch).map(asObject)) {
        const range = ["versionStartIncluding", "versionStartExcluding", "versionEndIncluding", "versionEndExcluding"]
          .flatMap((key) => match[key] === undefined ? [] : [`${key}=${asText(match[key])}`]);
        lines.push(`affects ${asText(match.criteria)} ${range.join(" ")}`.trim());
      }
    }
  }
  for (const reference of asArray(record.references).map(asObject).slice(0, 12)) lines.push(`reference ${asText(reference.url)}`);
  return lines.join("\n");
}

/** A CVE record from OSV: the summary and which packages and version events it affects. */
export function osvText(body: string): string {
  const record = asObject(JSON.parse(body));
  const lines = [asText(record.id), asText(record.summary), asText(record.details)];
  for (const affected of asArray(record.affected).map(asObject)) {
    const pkg = asObject(affected.package);
    const events = asArray(affected.ranges).map(asObject).flatMap((range) => asArray(range.events).map((event) => JSON.stringify(event)));
    lines.push(`affects ${asText(pkg.ecosystem)} ${asText(pkg.name)} ${events.join(" ")}`.trim());
  }
  return lines.filter(Boolean).join("\n");
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * A CVE record from Red Hat's security data: how Red Hat rates it, the kernel or package build each release fixed it
 * in, and the releases it is not affected or still working on. These are Red Hat's own builds, which AlmaLinux and Rocky
 * rebuild under the same numbers.
 */
export function redhatText(body: string): string {
  const record = asObject(JSON.parse(body));
  const lines = [`Red Hat ${asText(record.name)}: severity ${asText(record.threat_severity)}`];
  for (const release of asArray(record.affected_release).map(asObject)) {
    const fixed = asText(release.package) === "" ? "" : ` fixed in ${asText(release.package)} (${asText(release.advisory)})`;
    if (fixed !== "") lines.push(`${asText(release.product_name)}:${fixed}`);
  }
  for (const state of asArray(record.package_state).map(asObject)) {
    lines.push(`${asText(state.product_name)}: ${asText(state.fix_state)} (${asText(state.package_name)})`);
  }
  return unique(lines).join("\n").slice(0, DISTRO_CAP);
}

/** Statuses that say nothing about a machine: the release does not ship the package, or no longer gets updates. */
const UBUNTU_SILENT = /^(not in release|ignored)/i;

/**
 * A CVE page from Ubuntu's security tracker (its markdown form) as one line per source package: each release's status,
 * with the fixed package version where there is one. The page lists hundreds of releases that carry nothing, so those
 * rows are dropped.
 */
export function ubuntuText(markdown: string): string {
  const lines: string[] = [];
  const priority = /Ubuntu priority\s*\n+\s*\*\*([^*]+)\*\*/.exec(markdown)?.[1];
  if (priority !== undefined) lines.push(`Ubuntu priority: ${priority.trim()}`);
  let current = "";
  let rows: string[] = [];
  const flush = () => {
    if (current !== "" && rows.length > 0) lines.push(`Ubuntu package ${current}: ${rows.join("; ")}`);
    rows = [];
  };
  for (const raw of markdown.split("\n")) {
    if (!raw.startsWith("|")) continue;
    const cells = raw.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^-+$/.test(cell)) || cells[0] === "Package" || cells[0] === "Ubuntu Release") continue;
    if (cells.length >= 3) {
      flush();
      current = cells[0]!;
    }
    const [release, status] = cells.slice(-2) as [string, string];
    if (UBUNTU_SILENT.test(status)) continue;
    rows.push(`${release.replace(/\s+LTS\s+\w+$/, "").replace(/\s+\w+$/, "")}=${status.replace(/\s+/g, " ")}`);
  }
  flush();
  return lines.join("\n").slice(0, DISTRO_CAP);
}

/** What the network gives back for one address. */
export interface FetchedPage {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface ResearchDeps {
  /** Reads one address, following redirects, or throws why nothing came. */
  readonly fetchPage?: (url: string) => Promise<FetchedPage>;
  /** Searches the web for the owner's words; throws when no provider answers. */
  readonly search?: (query: string, limit: number) => Promise<readonly WebSearchResult[]>;
}

export async function systemFetchPage(url: string): Promise<FetchedPage> {
  const answer = await publicGet(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
    timeoutMs: FETCH_TIMEOUT_MS,
    bodyCap: FETCH_CAP,
  });
  return { status: answer.status, contentType: answer.headers["content-type"] ?? "", body: answer.body };
}

export async function systemSearch(query: string, limit: number): Promise<readonly WebSearchResult[]> {
  let failure = "no search provider is available";
  for (const provider of resolveProviders()) {
    try {
      return await searchWith(provider, query, limit);
    } catch (error) {
      failure = `${provider}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(failure);
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One address read into a source: its text, or why there is none. */
async function readSource(
  url: string,
  kind: AdvisorySource["kind"],
  fetchPage: NonNullable<ResearchDeps["fetchPage"]>,
  readable: (page: FetchedPage) => string,
): Promise<AdvisorySource> {
  try {
    const page = await fetchPage(url);
    if (page.status >= 400) return { url, kind, status: page.status, text: "", error: `HTTP ${page.status}` };
    return { url, kind, status: page.status, text: readable(page).slice(0, TEXT_CAP) };
  } catch (error) {
    return { url, kind, status: 0, text: "", error: describe(error) };
  }
}

const pageText = (page: FetchedPage): string =>
  /html/i.test(page.contentType) || /^\s*<(!doctype|html)/i.test(page.body) ? htmlToText(page.body) : page.body.trim();

/** Smallest first, so the prompt's character budget never starves the lines that carry a fixed version. */
const KIND_ORDER: readonly AdvisorySource["kind"][] = ["distro", "nvd", "osv", "search_result", "page"];

/** A CVE's records: NVD, OSV, and the fixed builds Red Hat and Ubuntu publish for it. */
function cveSources(cve: string, fetchPage: NonNullable<ResearchDeps["fetchPage"]>): Promise<AdvisorySource>[] {
  return [
    readSource(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve}`, "nvd", fetchPage, (page) => nvdText(page.body)),
    readSource(`https://api.osv.dev/v1/vulns/${cve}`, "osv", fetchPage, (page) => osvText(page.body)),
    readSource(`https://access.redhat.com/hydra/rest/securitydata/cve/${cve}.json`, "distro", fetchPage, (page) => redhatText(page.body)),
    readSource(`https://ubuntu.com/security/${cve}?format=md`, "distro", fetchPage, (page) => ubuntuText(page.body)),
  ];
}

/** The sources, plus the records of CVEs the pages read name that the owner's words did not, up to the shared limit. */
async function withNamedCves(
  sources: AdvisorySource[],
  known: readonly string[],
  fetchPage: NonNullable<ResearchDeps["fetchPage"]>,
): Promise<AdvisorySource[]> {
  const named = unique(
    sources.filter((source) => source.kind === "page").flatMap((source) => [...source.text.matchAll(/CVE-\d{4}-\d{4,}/gi)].map((match) => match[0].toUpperCase())),
  ).filter((cve) => !known.includes(cve));
  const more = await Promise.all(named.slice(0, Math.max(MAX_CVES - known.length, 0)).flatMap((cve) => cveSources(cve, fetchPage)));
  return [...sources, ...more].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/**
 * Everything the host can read about the advisory: each named page, each cited CVE's NVD, OSV and distro records
 * (a CVE only a page names is read too) and, when the words name no page or CVE, the top results of a web search and
 * the pages behind them. Every failure is kept as a source with its error, never dropped.
 */
export async function researchAdvisory(text: string, deps: ResearchDeps = {}): Promise<AdvisorySource[]> {
  const fetchPage = deps.fetchPage ?? systemFetchPage;
  const { urls, cves } = targetsIn(text);
  const pages = urls.slice(0, MAX_PAGES);
  const records = cves.slice(0, MAX_CVES);
  const sources = await Promise.all([
    ...pages.map((url) => readSource(url, "page", fetchPage, pageText)),
    ...records.flatMap((cve) => cveSources(cve, fetchPage)),
  ]);
  if (pages.length > 0 || records.length > 0) return withNamedCves(sources, records, fetchPage);
  const search = deps.search ?? systemSearch;
  let hits: readonly WebSearchResult[];
  try {
    hits = await search(text, MAX_SEARCH_PAGES + 2);
  } catch (error) {
    return [{ url: `search: ${text}`, kind: "search_result", status: 0, text: "", error: describe(error) }];
  }
  const listed: AdvisorySource = {
    url: `search: ${text}`,
    kind: "search_result",
    status: 200,
    text: hits.map((hit) => `${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n").slice(0, TEXT_CAP),
  };
  const followed = await Promise.all(
    hits.slice(0, MAX_SEARCH_PAGES).map((hit) => readSource(hit.url, "page", fetchPage, pageText)),
  );
  return withNamedCves([listed, ...followed], [], fetchPage);
}
