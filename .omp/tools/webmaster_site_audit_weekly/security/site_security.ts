import type { Collected } from "./tls_common";
import { answer, apexOf, bySeverity, type SecurityCheckResult, type SecurityFinding } from "./check";
import { CHECKS, type Picture, type SecurityData, type SecuritySettings } from "./composition";
import { DEFAULT_SUBDOMAINS, type SiteDnsResult } from "./dns";
import type { HomePage } from "./defacement";
import type { WordpressInspect } from "./inspect";
import type { ModelStep } from "./omp_model";
import type { WordpressPublicApi } from "./public_api";
import type { SitePublicFiles } from "./public_files";
import { DMARC_LABEL } from "./rules_email_dmarc";
import { dkimLabel, selectorsToAsk } from "./rules_email_dkim";
import type { ScreenshotMeasurement } from "./screenshot";
import type { SiteServer } from "./site_context";

/** One check's verdict, as the answer lists it. */
export interface CheckVerdict {
  check: string;
  status: SecurityCheckResult["status"];
  reason?: string;
}

/** What one site's security run answers. */
export interface SiteSecurityResult {
  /** The apex domain the run is about. */
  site: string;
  /** Every check's verdict. */
  checks: CheckVerdict[];
  /** Every check's findings, worst severity first. */
  findings: SecurityFinding[];
  /** Each check that could not run, with why. */
  unmeasured: { check: string; reason: string }[];
}

/** What a site file adds for a site: its settings and its other host names. Read-only. */
export interface SiteFileSecurity extends SecuritySettings {
  hostnames: string[];
}

/**
 * What the run needs from outside: the site file, and one collection per data tool. Every method collects and never
 * judges; a failed reading is data (`unmeasured`), never an exception. Only a cancelled run throws.
 */
export interface SiteSecurityPorts {
  /** The site file whose address is this site's, if any. */
  siteFile(site: string): Promise<SiteFileSecurity | undefined>;
  dns(site: string, subdomains: readonly string[], signal?: AbortSignal): Promise<SiteDnsResult>;
  certificate(site: string, origin: string | undefined, signal?: AbortSignal): Promise<Collected>;
  publicFiles(site: string, exposurePaths: readonly string[], signal?: AbortSignal): Promise<SitePublicFiles>;
  publicApi(site: string, signal?: AbortSignal): Promise<WordpressPublicApi>;
  inspect(site: string, server: SiteServer | undefined, signal?: AbortSignal): Promise<WordpressInspect>;
  homePage(site: string, signal?: AbortSignal): Promise<HomePage>;
  /**
   * The home page's picture and the model step that reads it; called only when the text checks leave it open. `home`
   * is what `homePage` read: a page that did not answer is not pictured.
   */
  picture(site: string, home: HomePage, signal?: AbortSignal): Promise<{ screenshot: ScreenshotMeasurement; step?: ModelStep }>;
}

/** What the caller may say about one site; each field overrides what the site file says. */
export type SecurityOverrides = SecuritySettings;

const isEmpty = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/** The settings: the caller's where given, else the site file's, leaving out a site file's empty list. */
export function completeSettings(given: SecurityOverrides, file: SiteFileSecurity | undefined): SecuritySettings {
  const settings: Record<string, unknown> = {};
  const fromFile: Record<string, unknown> = { ...(file ?? {}) };
  for (const key of [
    "origin",
    "server",
    "dkim_selectors",
    "tls_warn_days",
    "known_mu_plugins",
    "debug_file_patterns",
    "defacement_patterns",
    "exposure_paths",
  ] as const) {
    const given_ = given[key];
    if (given_ !== undefined) settings[key] = given_;
    else if (fromFile[key] !== undefined && !isEmpty(fromFile[key])) settings[key] = fromFile[key];
  }
  return settings as SecuritySettings;
}

const labelsUnder = (apex: string, hostnames: readonly string[]): string[] =>
  hostnames.flatMap((hostname) => hostname.endsWith(`.${apex}`) ? [hostname.slice(0, -`.${apex}`.length)] : []);

/** The DNS labels one run asks for: the common subdomains, the site file's other names, `_dmarc` and each DKIM selector's key name. */
export function dnsLabels(apex: string, file: SiteFileSecurity | undefined, settings: SecuritySettings): string[] {
  return [
    ...DEFAULT_SUBDOMAINS,
    ...labelsUnder(apex, file?.hostnames ?? []),
    DMARC_LABEL,
    ...selectorsToAsk(settings.dkim_selectors).map(dkimLabel),
  ];
}

/**
 * A site's security, by orchestration only: it collects each data field once, then hands every check the data and
 * settings it reads. It judges nothing itself; the checks do. A cancelled run throws.
 */
export async function runSiteSecurity(
  site: string,
  ports: SiteSecurityPorts,
  overrides: SecurityOverrides = {},
  signal?: AbortSignal,
  progress?: (note: string) => void,
): Promise<SiteSecurityResult> {
  const apex = apexOf(site);
  const file = await ports.siteFile(site);
  const settings = completeSettings(overrides, file);
  const data: SecurityData = {};

  progress?.(`reading DNS for ${apex}`);
  const dns = await ports.dns(site, dnsLabels(apex, file, settings), signal);
  data.names = dns.names;
  progress?.(`reading the TLS certificate for ${apex}`);
  data.certificate = await ports.certificate(site, settings.origin, signal);
  progress?.(`reading public files on ${apex}`);
  data.public_files = await ports.publicFiles(site, settings.exposure_paths ?? [], signal);
  progress?.(`reading the WordPress public API on ${apex}`);
  data.public_api = await ports.publicApi(site, signal);
  progress?.(`inspecting the server behind ${apex}`);
  data.inspect = await ports.inspect(site, settings.server, signal);
  progress?.(`reading the home page of ${apex}`);
  data.home_page = await ports.homePage(site, signal);

  let held: { screenshot: ScreenshotMeasurement; step?: ModelStep } | undefined;
  const picture: Picture = async () => {
    held ??= await ports.picture(site, data.home_page ?? { status: "unmeasured", reason: "the home page was not read" }, signal);
    return held;
  };
  try {
    progress?.(`judging ${CHECKS.length} checks for ${apex}`);
    const results = await Promise.all(CHECKS.map(async (check): Promise<SecurityCheckResult> => {
      try {
        return answer(apex, check.name, await check.run({ site, data, settings, picture, signal }));
      } catch (error) {
        signal?.throwIfAborted();
        // A check that throws judged nothing: it is unmeasured with its reason, never a pass.
        return answer(apex, check.name, { unmeasured: `the check failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }));
    return {
      site: apex,
      checks: results.map(({ check, status, reason }) => ({ check, status, ...(reason === undefined ? {} : { reason }) })),
      findings: results.flatMap((result) => result.findings).sort(bySeverity),
      unmeasured: results.flatMap(({ check, status, reason }) =>
        status === "unmeasured" ? [{ check, reason: reason ?? "no reason given" }] : []
      ),
    };
  } finally {
    if (held?.screenshot.status === "measured") await held.screenshot.release().catch(() => undefined);
  }
}

/** One site of the daily run: its result, or why it could not be checked. */
export type SiteOutcome =
  | { site: string; status: "checked"; result: SiteSecurityResult }
  | { site: string; status: "failed"; error: string };

export interface SecurityRun {
  sites: SiteOutcome[];
  /** How many findings of each severity, over every checked site. */
  totals: Record<string, number>;
}

/** What the daily run needs besides one site's ports: the site names, and one site file name's address. */
export interface DailyPorts {
  /** Every site file that lists `security` among its capabilities. */
  sites(): Promise<string[]>;
  /** The site's address, from `<name>.yaml`. Throws when the file is missing or not a site file. */
  addressOf(name: string): Promise<string>;
  /** One site's check. */
  check(address: string, progress?: (note: string) => void): Promise<SiteSecurityResult>;
}

/**
 * `webmaster_site_security` over the named sites (else every site file that lists `security`), one after another (a
 * host may allow one SSH session at a time). A site that fails is recorded with its error and the rest still run; a
 * cancelled run throws. Nothing is fixed or sent anywhere.
 */
export async function checkSites(
  names: readonly string[] | undefined,
  ports: DailyPorts,
  signal?: AbortSignal,
  progress?: (note: string) => void,
): Promise<SecurityRun> {
  const listed = names ?? await ports.sites();
  const sites: SiteOutcome[] = [];
  for (const site of listed) {
    signal?.throwIfAborted();
    try {
      const address = await ports.addressOf(site);
      sites.push({ site, status: "checked", result: await ports.check(address, (note) => progress?.(`${site}: ${note}`)) });
    } catch (error) {
      signal?.throwIfAborted();
      sites.push({ site, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const totals: Record<string, number> = {};
  for (const entry of sites) {
    if (entry.status !== "checked") continue;
    for (const finding of entry.result.findings) totals[finding.severity] = (totals[finding.severity] ?? 0) + 1;
  }
  return { sites, totals };
}
