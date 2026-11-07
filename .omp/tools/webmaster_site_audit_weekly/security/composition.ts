/**
 * What `webmaster_site_security` composes: the data each check reads, the settings it takes, and its rule. The one table
 * the orchestrator runs, in the order the findings are reported. Checks judge and never fetch.
 */
import type { Collected } from "./tls_common";
import type { Verdict } from "./check";
import { type DnsName } from "./dns";
import { type HomePage, CHECK as DEFACEMENT, defacementVerdictBySight } from "./defacement";
import { CHECK as EXPOSED, exposedVerdict } from "./exposed_files";
import type { WordpressInspect } from "./inspect";
import type { ModelStep } from "./omp_model";
import type { SitePublicFiles } from "./public_files";
import type { WordpressPublicApi } from "./public_api";
import { CHECK as DANGLING, danglingVerdict } from "./rules_dns_dangling";
import { CHECK as DKIM, dkimVerdict } from "./rules_email_dkim";
import { CHECK as DMARC, dmarcVerdict } from "./rules_email_dmarc";
import { CHECK as SPF, spfVerdict } from "./rules_email_spf";
import { CHECK as TLS_EXPIRY, expiryVerdict } from "./rules_tls_expiry";
import { CHECK as TLS_HOSTNAME, hostnameVerdict } from "./rules_tls_hostname";
import { CHECK as TLS_ORIGIN, originVerdict } from "./rules_tls_origin_mismatch";
import { CHECK as TLS_TRUST, trustVerdict } from "./rules_tls_trust";
import type { ScreenshotMeasurement } from "./screenshot";
import type { SiteServer } from "./site_context";
import { CHECK as AUTO_UPDATE, autoUpdateHealthVerdict } from "./wp_auto_update_health";
import { CHECK as CORE_INTEGRITY, coreIntegrityVerdict } from "./wp_core_integrity";
import { CHECK as CORE_VERSION, coreVersionVerdict } from "./wp_core_version";
import { CHECK as CRON, cronVerdict } from "./wp_cron";
import { CHECK as MU_PLUGINS, muPluginsVerdict } from "./wp_mu_plugins";
import { CHECK as NEW_ADMINS, newAdminsVerdict } from "./wp_new_admins";
import { CHECK as PLUGIN_INTEGRITY, pluginIntegrityVerdict } from "./wp_plugin_integrity";
import { CHECK as RECENT_PLUGIN_CHANGES, recentPluginChangesVerdict } from "./wp_recent_plugin_changes";
import { CHECK as REST_BATCH, restBatchVerdict } from "./wp_rest_batch";
import { CHECK as UPLOADS_PHP, uploadsPhpVerdict } from "./wp_uploads_php";
import { CHECK as USER_ENUMERATION, userEnumerationVerdict } from "./wp_user_enumeration";
import { CHECK as XMLRPC, xmlrpcVerdict } from "./wp_xmlrpc";

/** The data collected once per site, one field per data collection. */
export interface SecurityData {
  names?: DnsName[];
  certificate?: Collected;
  public_files?: SitePublicFiles;
  public_api?: WordpressPublicApi;
  inspect?: WordpressInspect;
  home_page?: HomePage;
}

/** The settings a site file adds (or the caller gives) that a check reads. */
export interface SecuritySettings {
  origin?: string;
  server?: SiteServer;
  dkim_selectors?: string[];
  tls_warn_days?: number;
  known_mu_plugins?: string[];
  debug_file_patterns?: string[];
  defacement_patterns?: string[];
  exposure_paths?: string[];
}

/** The picture of the home page, taken only when a check needs it, and the model step that reads it. */
export type Picture = () => Promise<{ screenshot: ScreenshotMeasurement; step?: ModelStep }>;

export interface CheckContext {
  /** The site as the caller named it (a domain or an address). */
  readonly site: string;
  readonly data: SecurityData;
  readonly settings: SecuritySettings;
  readonly picture: Picture;
  readonly signal?: AbortSignal | undefined;
}

export interface CheckDefinition {
  readonly name: string;
  run(context: CheckContext): Verdict | Promise<Verdict>;
}

/** The checks, by name and in report order, each with the data and settings it reads. */
export const CHECKS: readonly CheckDefinition[] = [
  { name: DANGLING, run: ({ site, data }) => danglingVerdict(site, data.names) },
  { name: DKIM, run: ({ site, data, settings }) => dkimVerdict(site, data.names, settings.dkim_selectors) },
  { name: DMARC, run: ({ site, data }) => dmarcVerdict(site, data.names) },
  { name: SPF, run: ({ site, data }) => spfVerdict(site, data.names) },
  {
    name: DEFACEMENT,
    run: ({ site, data, settings, picture, signal }) =>
      defacementVerdictBySight({
        site,
        ...(data.home_page === undefined ? {} : { home_page: data.home_page }),
        ...(data.public_files === undefined ? {} : { public_files: data.public_files }),
        defacement_patterns: settings.defacement_patterns ?? [],
      }, picture, signal),
  },
  { name: EXPOSED, run: ({ data }) => exposedVerdict(data.public_files) },
  { name: TLS_EXPIRY, run: ({ data, settings }) => expiryVerdict(data.certificate, settings.tls_warn_days) },
  { name: TLS_HOSTNAME, run: ({ data }) => hostnameVerdict(data.certificate) },
  { name: TLS_ORIGIN, run: ({ data, settings }) => originVerdict(data.certificate, settings.tls_warn_days) },
  { name: TLS_TRUST, run: ({ data }) => trustVerdict(data.certificate) },
  { name: AUTO_UPDATE, run: ({ data }) => autoUpdateHealthVerdict(data.inspect, data.public_api) },
  { name: CORE_INTEGRITY, run: ({ data }) => coreIntegrityVerdict(data.inspect) },
  { name: CORE_VERSION, run: ({ data }) => coreVersionVerdict(data.public_api) },
  { name: CRON, run: ({ data }) => cronVerdict(data.inspect) },
  {
    name: MU_PLUGINS,
    run: ({ data, settings }) =>
      muPluginsVerdict(data.inspect, {
        known_mu_plugins: settings.known_mu_plugins,
        debug_file_patterns: settings.debug_file_patterns,
      }),
  },
  { name: NEW_ADMINS, run: ({ data }) => newAdminsVerdict(data.inspect) },
  { name: PLUGIN_INTEGRITY, run: ({ data }) => pluginIntegrityVerdict(data.inspect) },
  { name: RECENT_PLUGIN_CHANGES, run: ({ data }) => recentPluginChangesVerdict(data.inspect) },
  { name: REST_BATCH, run: ({ data }) => restBatchVerdict(data.public_api) },
  { name: UPLOADS_PHP, run: ({ data }) => uploadsPhpVerdict(data.inspect) },
  { name: USER_ENUMERATION, run: ({ data }) => userEnumerationVerdict(data.public_api) },
  { name: XMLRPC, run: ({ data }) => xmlrpcVerdict(data.public_api) },
];
