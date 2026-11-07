import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  COMMAND_TIMEOUT_MS,
  measureWordpressInspect,
  type ProcessResult,
  type RunProcess,
  SERVER_GATHER_ENVIRONMENT,
  SERVER_OFF_REASON,
  type WordpressInspect,
} from "./inspect.ts";
import { apexOf, siteContextForAddress, type SiteServer } from "./site_context.ts";

export interface InspectToolDeps {
  /** Runs `ssh`; the factory wraps `pi.exec`. */
  run?: RunProcess;
  /** Where the owner's site files are; the default is `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites`. */
  sitesDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Record what a fixed list of read-only WP-CLI and `find` commands print on a WordPress site's server over SSH: core and plugin checksum verification, administrators, plugins (also the must-use list), scheduled cron events, core version, who hooks WordPress' update filters, plugin and theme lists with updates, the content folders, PHP files under uploads, and plugin and theme folders changed in the last 14 days. "
  + "Use it for the raw server reading; it never judges what the commands printed (the webmaster_security_wordpress_* checks do) and runs nothing outside its fixed list. It writes nothing on the server. "
  + "Input: `{\"site\":\"example.org\"}`. `site` is a domain or address. The SSH host, WordPress root, WP-CLI and file prefixes come from the matching site file's `host` block under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`), or from the optional `server` input `{transport:\"ssh\",target,wp_root,wp_cli?,file_prefix?}`; every value must be plain words. "
  + "It only runs when `WEBMASTER_SECURITY_SERVER=1` is set in omp's environment; otherwise the result is `unmeasured` and no connection is made. SSH uses BatchMode and the SSH agent (no password or key is read), one `ssh` session per command, 13 commands, 15 s connect and 5 min per command. "
  + "Result: `{site, inspect}`; `inspect` is `measured` with `measured_at`, `recent_days` and `outputs[]` (`command`, `command_line`, `code`, `stdout`, `stderr`) or `unmeasured` with a reason (server checks off, no SSH host, the session did not open).";

/** The real runner: omp's `exec`, a stopped command recorded as code -1, a cancelled run thrown. */
export function runWithPi(pi: Pi): RunProcess {
  return async (command, args, signal) => {
    const result = await pi.exec(command, [...args], { cwd: pi.cwd, timeout: COMMAND_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    const out: ProcessResult = {
      code: result.killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.killed ? `${result.stderr}\nstopped after ${COMMAND_TIMEOUT_MS} ms`.trim() : result.stderr,
    };
    return out;
  };
}

const serverOf = (value: {
  transport: string;
  target: string;
  wp_root: string;
  wp_cli?: string | null;
  file_prefix?: string | null;
  php_fpm_user?: string | null;
}): SiteServer => ({
  transport: value.transport,
  target: value.target,
  wp_root: value.wp_root,
  ...(value.wp_cli == null ? {} : { wp_cli: value.wp_cli }),
  ...(value.file_prefix == null ? {} : { file_prefix: value.file_prefix }),
  ...(value.php_fpm_user == null ? {} : { php_fpm_user: value.php_fpm_user }),
});

export function makeTool(pi: Pi, deps: InspectToolDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: "webmaster_wordpress_inspect",
    label: "WordPress server inspection",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org`; matched to a site file by host."),
      server: z.object({
        transport: z.string().describe("`ssh` is the only transport the inspection can use."),
        target: z.string().describe("SSH host alias or `user@host`; plain words only."),
        wp_root: z.string().describe("The WordPress root on the server, absolute or relative to the login directory."),
        wp_cli: z.string().nullable().optional().describe("The command that runs WP-CLI as the site's user when it is not `wp`."),
        file_prefix: z.string().nullable().optional().describe("The prefix that runs a file command as the site's user."),
        php_fpm_user: z.string().nullable().optional().describe("The site's php-fpm pool user; recorded, not used here."),
      }).nullable().optional().describe("How to reach the site's server. Omit to use the site file's `host` block."),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; server?: Parameters<typeof serverOf>[0] | null },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const site = apexOf(params.site);
      const environment = deps.environment ?? process.env;
      let inspect: WordpressInspect;
      if (environment[SERVER_GATHER_ENVIRONMENT] !== "1") {
        inspect = { status: "unmeasured", reason: SERVER_OFF_REASON };
      } else {
        const server =
          params.server == null
            ? (await siteContextForAddress(params.site, deps.sitesDirectory))?.security?.server
            : serverOf(params.server);
        inspect = await measureWordpressInspect(server, run, {
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(signal === undefined ? {} : { signal }),
        });
      }
      const result = { site, inspect };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
