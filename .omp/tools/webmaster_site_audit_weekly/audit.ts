import type { SiteSecurityResult } from "./security/site_security";
import type { Finding } from "./sitemap/types";

/** Key URLs audited per site. The rest are named, not fetched, so a long site file cannot schedule a long run. */
export const PAGE_CAP = 8;

/** What the page audit returns for one key URL, as the audit keeps it. */
export interface PageAuditSlice {
  health: "healthy" | "needs_attention" | "critical" | "unknown";
  headline: string;
  findings: ({ severity: string } & Record<string, unknown>)[];
  unmeasured: { area: string; reason: string }[];
  purpose: string;
  interpretation: { measurement: string; consequence: string }[];
}

/** What the sitemap check returns, as the audit keeps it. */
export interface SitemapSlice {
  sitemap_url: string;
  urls_total: number;
  findings: Finding[];
  unmeasured?: string;
}

/** What the audit needs from outside. Each call throws what failed; the audit keeps that as data. */
export interface SiteAuditPorts {
  /** Site names when the input names none: every site file, not only those listing `security`. */
  sites(): Promise<string[]>;
  /** The site's address and the key page addresses declared in its file. */
  pages(site: string): Promise<{ url: string; pages: string[] }>;
  /** The site security check for one site. */
  security(site: string, signal?: AbortSignal): Promise<SiteSecurityResult>;
  /** The sitemap check for one site. */
  sitemap(site: string, url: string, signal?: AbortSignal): Promise<SitemapSlice>;
  /** The page audit for one key URL. `research` is the audit input's flag. */
  auditPage(site: string, url: string, research: boolean, signal?: AbortSignal): Promise<PageAuditSlice>;
}

export type Failed = { status: "failed"; error: string };

export type PageRow = (PageAuditSlice & { url: string; status: "audited" }) | (Failed & { url: string });

export interface SiteAuditResult {
  site: string;
  url?: string;
  status: "audited" | "failed";
  error?: string;
  /** Declared key URLs past the cap, not fetched. */
  pagesTruncated?: number;
  security?: { status: "checked"; result: SiteSecurityResult } | Failed;
  sitemap?: ({ status: "checked" } & SitemapSlice) | Failed;
  pages: PageRow[];
}

export interface SiteAudit {
  sites: SiteAuditResult[];
  /** How many findings of each severity, over every check that returned. */
  totals: Record<string, number>;
  research: boolean;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function addFindings(totals: Record<string, number>, findings: readonly { severity: string }[]): void {
  for (const finding of findings) totals[finding.severity] = (totals[finding.severity] ?? 0) + 1;
}

export interface AuditInput {
  sites?: readonly string[] | undefined;
  research?: boolean | undefined;
}

/**
 * Security, the sitemap, and a page audit of each site's declared key URLs, one site after another (a host may allow
 * one SSH session at a time). A site, check or page that fails is recorded and the rest still run; a cancelled run
 * throws. Nothing is fixed, filed or sent.
 */
export async function auditSites(
  input: AuditInput,
  ports: SiteAuditPorts,
  signal?: AbortSignal,
  progress?: (note: string) => void,
): Promise<SiteAudit> {
  const research = input.research ?? false;
  const names = input.sites === undefined ? await ports.sites() : [...new Set(input.sites)];
  const sites: SiteAuditResult[] = [];
  const totals: Record<string, number> = {};
  for (const site of names) {
    signal?.throwIfAborted();
    progress?.(`${site}: locating`);
    let located: { url: string; pages: string[] };
    try {
      located = await ports.pages(site);
    } catch (error) {
      signal?.throwIfAborted();
      sites.push({ site, status: "failed", error: message(error), pages: [] });
      continue;
    }
    const pages = located.pages.slice(0, PAGE_CAP);
    const pagesTruncated = located.pages.length - pages.length;
    let security: SiteAuditResult["security"];
    progress?.(`${site}: security`);
    try {
      const result = await ports.security(site, signal);
      security = { status: "checked", result };
      addFindings(totals, result.findings);
    } catch (error) {
      signal?.throwIfAborted();
      security = { status: "failed", error: message(error) };
    }
    let sitemap: SiteAuditResult["sitemap"];
    progress?.(`${site}: sitemap`);
    try {
      const found = await ports.sitemap(site, located.url, signal);
      sitemap = { status: "checked", ...found };
      addFindings(totals, found.findings);
    } catch (error) {
      signal?.throwIfAborted();
      sitemap = { status: "failed", error: message(error) };
    }
    const rows: PageRow[] = [];
    for (const url of pages) {
      progress?.(`${site}: page ${url}`);
      try {
        const audited = await ports.auditPage(site, url, research, signal);
        rows.push({ url, status: "audited", ...audited });
        addFindings(totals, audited.findings);
      } catch (error) {
        signal?.throwIfAborted();
        rows.push({ url, status: "failed", error: message(error) });
      }
    }
    sites.push({
      site,
      url: located.url,
      status: "audited",
      ...(pagesTruncated > 0 ? { pagesTruncated } : {}),
      security,
      sitemap,
      pages: rows,
    });
  }
  return { sites, totals, research };
}
