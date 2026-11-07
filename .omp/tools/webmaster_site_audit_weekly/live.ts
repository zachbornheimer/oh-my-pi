import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SiteAuditPorts } from "./audit";
import { livePorts, type LiveDeps } from "./security/live";
import { runSiteSecurity } from "./security/site_security";
import type { Exec, ModelStep } from "./sitemap/omp_model";
import { ompModelStep } from "./sitemap/omp_model";
import { pageAuditPort, type PageDeps } from "./page_port";
import { type GetPage } from "./sitemap/crawl";
import { siteContextNamed, sitesDirectory } from "./sitemap/site_context";
import { runSitemap } from "./sitemap/sitemap";

export interface AuditDeps {
  /** `pi.exec`. */
  exec: Exec;
  environment?: Readonly<Record<string, string | undefined>>;
  sitesDirectory?: string;
  /** The model step the sitemap check uses; spawns `omp -p` by default. */
  model?: ModelStep;
  getPage?: GetPage;
  /** Collection ports for the security check; the real ones by default. */
  security?: LiveDeps;
  /** omp's `pi.zod`, which validates the page audit's model replies. Required unless `auditPage` is injected. */
  zod?: PageDeps["zod"];
  /** What the built-in page audit reaches outside itself for (probes, browser, search, model step); the real ones by default. */
  page?: Partial<Omit<PageDeps, "zod" | "exec" | "sitesDirectory">>;
  /** Replaces the built-in page audit; tests pass a fake. */
  auditPage?: SiteAuditPorts["auditPage"];
}

/** Absolute addresses of a site file's `uptime.key_urls`, or the site address alone when it declares none. */
export function keyUrls(yamlText: string, siteUrl: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlText);
  } catch {
    parsed = undefined;
  }
  const uptime = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["uptime"] : undefined;
  const entries = typeof uptime === "object" && uptime !== null ? (uptime as Record<string, unknown>)["key_urls"] : undefined;
  const paths = Array.isArray(entries)
    ? entries.flatMap((entry) => {
      const path = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["path"] : undefined;
      return typeof path === "string" ? [path] : [];
    })
    : [];
  const urls = paths.flatMap((path) => {
    try {
      return [new URL(path, siteUrl).href];
    } catch {
      return [];
    }
  });
  return urls.length === 0 ? [siteUrl] : [...new Set(urls)];
}

/** The ports over this machine: site files, the security check, the sitemap check, and the page audit when it exists. */
export function liveAuditPorts(deps: AuditDeps): SiteAuditPorts {
  const environment = deps.environment ?? process.env;
  const directory = deps.sitesDirectory ?? sitesDirectory(environment);
  const model = deps.model ?? ompModelStep(deps.exec);
  const security = livePorts({ environment, sitesDirectory: directory, ...(deps.security ?? {}), exec: deps.exec as never });
  return {
    async sites() {
      return (await readdir(directory).catch(() => [] as string[]))
        .filter((file) => file.endsWith(".yaml"))
        .sort()
        .map((file) => file.slice(0, -".yaml".length));
    },
    async pages(site) {
      const context = await siteContextNamed(site, directory);
      const text = await readFile(join(directory, `${site}.yaml`), "utf8");
      return { url: context.url, pages: keyUrls(text, context.url) };
    },
    async security(site, signal) {
      const context = await siteContextNamed(site, directory);
      return runSiteSecurity(context.url, security, {}, signal);
    },
    async sitemap(site, url, signal): Promise<Awaited<ReturnType<SiteAuditPorts["sitemap"]>>> {
      const result = await runSitemap(
        { site_url: url, site },
        {
          model,
          sitesDirectory: directory,
          ...(deps.getPage === undefined ? {} : { getPage: deps.getPage }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return {
        sitemap_url: result.sitemap_url,
        urls_total: result.urls_total,
        findings: result.findings,
        ...(result.unmeasured === undefined ? {} : { unmeasured: result.unmeasured }),
      };
    },
    auditPage: deps.auditPage ?? (deps.zod === undefined
      ? async () => {
        throw new Error("the page audit needs omp's zod (`pi.zod`) to validate model replies, and none was given");
      }
      : pageAuditPort({ zod: deps.zod, exec: deps.exec as never, sitesDirectory: directory, ...(deps.page ?? {}) })),
  };
}
