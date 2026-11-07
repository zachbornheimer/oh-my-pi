import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type LiveDeps, livePorts, siteAddressOf } from "./live";
import type { Exec } from "./omp_model";
import { withHeartbeat } from "./omp_model";
import type { SiteServer } from "./site_context";
import { runSiteSecurity, type SecurityOverrides, type SiteSecurityPorts } from "./site_security";

export const NAME = "webmaster_site_security";

export const DESCRIPTION =
  "Check one WordPress site from outside for exposures and signs of compromise by running 22 checks on data collected once: DNS (dangling CNAMEs, SPF, DMARC, DKIM), TLS (expiry, host name, trust, origin mismatch), public files (exposed files, defacement), the WordPress public API (core version, XML-RPC, REST batch, user enumeration) and, only when `WEBMASTER_SECURITY_SERVER=1`, a fixed read-only WP-CLI inspection over SSH (core and plugin integrity, administrators, must-use plugins, cron, PHP in uploads, plugin changes, auto-update health). "
  + "Use it after an alert or for one site's sweep; every site at once is `webmaster_site_security_daily`, and one raw reading or one check belongs to the `webmaster_site_*`, `webmaster_wordpress_*` or `webmaster_security_*` tool. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"example\"}` (a name with no dot is a site file under `WEBMASTER_SITES_DIR`, default `~/Developer/Zysys/webmaster/sites`), plus optional overrides of the site file: `origin`, `dkim_selectors`, `tls_warn_days`, `known_mu_plugins`, `debug_file_patterns`, `defacement_patterns`, `exposure_paths`, `server`. "
  + "A defacer's phrase on the home page or a drop page fails without a model call; otherwise it launches headless Chrome and makes one billed `omp -p` call that reads the picture. A check whose data could not be read is `unmeasured` with a reason, NEVER pass. "
  + "Result: `{site,checks:[{check,status,reason?}],findings,unmeasured:[{check,reason}]}`; findings are worst first, each with `id`, `severity`, `evidence`, `containment`, `fix_hint`. An unparsable site throws. "
  + "Sends DNS queries, TLS handshakes and dozens of requests to public addresses; never fixes, deletes, quarantines, rotates or messages anyone.";

type Pi = Parameters<CustomToolFactory>[0];

export interface Params {
  site: string;
  origin?: string | null;
  dkim_selectors?: string[] | null;
  tls_warn_days?: number | null;
  known_mu_plugins?: string[] | null;
  debug_file_patterns?: string[] | null;
  defacement_patterns?: string[] | null;
  exposure_paths?: string[] | null;
  server?: {
    transport: string;
    target: string;
    wp_root: string;
    wp_cli?: string | null;
    file_prefix?: string | null;
    php_fpm_user?: string | null;
  } | null;
}

export interface ToolDeps extends Partial<Omit<LiveDeps, "exec">> {
  /** Replaces the live collection ports entirely; tests pass recorded ones. */
  ports?: SiteSecurityPorts;
}

/** A site file's name: letters, digits, `_` and `-`; a host has a dot, so it is never one. */
const SITE_FILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

const serverOf = (value: NonNullable<Params["server"]>): SiteServer => ({
  transport: value.transport,
  target: value.target,
  wp_root: value.wp_root,
  ...(value.wp_cli == null ? {} : { wp_cli: value.wp_cli }),
  ...(value.file_prefix == null ? {} : { file_prefix: value.file_prefix }),
  ...(value.php_fpm_user == null ? {} : { php_fpm_user: value.php_fpm_user }),
});

/** The caller's overrides, with `null` meaning not given. */
export function overridesOf(params: Omit<Params, "site"> & { site?: unknown }): SecurityOverrides {
  return {
    ...(params.origin == null ? {} : { origin: params.origin }),
    ...(params.dkim_selectors == null ? {} : { dkim_selectors: params.dkim_selectors }),
    ...(params.tls_warn_days == null ? {} : { tls_warn_days: params.tls_warn_days }),
    ...(params.known_mu_plugins == null ? {} : { known_mu_plugins: params.known_mu_plugins }),
    ...(params.debug_file_patterns == null ? {} : { debug_file_patterns: params.debug_file_patterns }),
    ...(params.defacement_patterns == null ? {} : { defacement_patterns: params.defacement_patterns }),
    ...(params.exposure_paths == null ? {} : { exposure_paths: params.exposure_paths }),
    ...(params.server == null ? {} : { server: serverOf(params.server) }),
  };
}

export function makeTool(pi: Pi, deps: ToolDeps = {}) {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  const live: LiveDeps = { exec, ...deps };
  const ports = deps.ports ?? livePorts(live);
  return {
    name: NAME,
    label: "Site security check",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    parameters: z.object({
      site: z.string().min(1).describe(
        "The site: a domain or address (`example.org`, `https://www.example.org/`), or a site file name without a dot (`example`).",
      ),
      origin: z.string().min(1).nullable().optional().describe("Origin server host name or IP behind an edge; overrides the site file."),
      dkim_selectors: z.array(z.string()).nullable().optional().describe("Extra DKIM selectors to ask for; overrides the site file."),
      tls_warn_days: z.number().int().positive().nullable().optional().describe("Days before a certificate ends that it is reported; default 21."),
      known_mu_plugins: z.array(z.string()).nullable().optional().describe("Must-use plugin names the owner vouches for; overrides the site file."),
      debug_file_patterns: z.array(z.string()).nullable().optional().describe("Globs of debug files flagged among must-use plugins; overrides the site file."),
      defacement_patterns: z.array(z.string()).nullable().optional().describe("Extra phrases, matched without case, that mean the site was defaced; overrides the site file."),
      exposure_paths: z.array(z.string()).nullable().optional().describe("Extra site paths to ask for, each starting with `/` (at most 50); overrides the site file."),
      server: z.object({
        transport: z.string().describe("`ssh` is the only transport the inspection can use."),
        target: z.string().describe("SSH host alias or `user@host`; plain words only."),
        wp_root: z.string().describe("The WordPress root on the server, absolute or relative to the login directory."),
        wp_cli: z.string().nullable().optional().describe("The command that runs WP-CLI as the site's user when it is not `wp`."),
        file_prefix: z.string().nullable().optional().describe("The prefix that runs a file command as the site's user."),
        php_fpm_user: z.string().nullable().optional().describe("The site's php-fpm pool user; recorded, not used here."),
      }).nullable().optional().describe("How to reach the site's server for the inspection (runs only with `WEBMASTER_SECURITY_SERVER=1`); overrides the site file's `host` block."),
    }),
    async execute(
      _toolCallId: string,
      params: Params,
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const note = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "running" } });
      const result = await withHeartbeat(onUpdate, "Checking site security", async () => {
        const address = SITE_FILE_NAME.test(params.site)
          ? await siteAddressOf(live, params.site)
          : params.site;
        return runSiteSecurity(address, ports, overridesOf(params), signal, note);
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
