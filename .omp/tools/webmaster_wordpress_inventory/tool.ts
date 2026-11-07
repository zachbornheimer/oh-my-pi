import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type InventoryOutput, runInventory } from "./inventory.ts";
import {
  COMMAND_TIMEOUT_MS,
  type InspectCommand,
  measureWordpressInspect,
  type ProcessResult,
  type RunProcess,
  SERVER_GATHER_ENVIRONMENT,
  SERVER_OFF_REASON,
} from "./inspect.ts";
import { type Exec, type ModelStep, askJson, ompModelStep, withHeartbeat } from "./omp_model.ts";
import { type SecurityNet, systemSecurityNet } from "./net.ts";
import { promptFor } from "./question.ts";
import { readReleases } from "./releases.ts";
import { apexOf, siteContextForAddress, type SiteServer } from "./site_context.ts";

export interface InventoryToolDeps {
  /** Runs `ssh`; the factory wraps `pi.exec`. */
  run?: RunProcess;
  /** The model step; the factory spawns `omp -p` through `pi.exec`. */
  model?: ModelStep;
  net?: SecurityNet;
  sitesDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => string;
}

type Pi = Parameters<CustomToolFactory>[0];

/** The only fixed commands the inventory reads. */
export const INVENTORY_COMMANDS: readonly InspectCommand[] = ["core_version", "plugin_list", "theme_list"];

export const DESCRIPTION =
  "List the plugins, themes and core a WordPress site runs, each with its installed version, the newest version available, whether it is outdated, its official URL and notes on what looks wrong (no version, no known official source, must-use plugins and drop-ins). "
  + "Use it to learn which plugins or themes are outdated, what versions a site has installed, or to check an alert's plugin and version against the site. It never installs, upgrades or changes anything, does not look up advisories and never says an item is vulnerable. "
  + "Input: `{\"site\":\"example.org\"}`. The SSH host, WordPress root and WP-CLI prefix come from the matching site file's `host` block under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`), or from the optional `server` input; every value must be plain words. "
  + "It only reads the server when `WEBMASTER_SECURITY_SERVER=1` is set in omp's environment; otherwise the result is `unmeasured` and nothing is sent. When on: 3 read-only WP-CLI commands over SSH (BatchMode, SSH agent only; 5 min each), one GET to api.wordpress.org for core releases, then one `omp -p` model call (billed, up to 3 attempts) that supplies only the official URL, a clean name and notes. "
  + "Result: `{site, inventory}`: `measured` with `core`, `plugins[]`, `themes[]` (`slug`, `name`, `status`, `installed_version`, `latest_version`, `up_to_date` yes/no/unknown, `official_url`, `suspicious[]`) and `judgment_unavailable` when the model failed (versions then stand, URLs and notes are missing), or `unmeasured` with a reason. Versions come from the server, never from the model.";

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
}): SiteServer => ({
  transport: value.transport,
  target: value.target,
  wp_root: value.wp_root,
  ...(value.wp_cli == null ? {} : { wp_cli: value.wp_cli }),
  ...(value.file_prefix == null ? {} : { file_prefix: value.file_prefix }),
});

export function makeTool(pi: Pi, deps: InventoryToolDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  const model: ModelStep = deps.model ?? ompModelStep(pi.exec as unknown as Exec);
  return {
    name: "webmaster_wordpress_inventory",
    label: "WordPress inventory",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `isjac.org`; matched to a site file by host."),
      server: z.object({
        transport: z.string().describe("`ssh` is the only transport the inventory can use."),
        target: z.string().describe("SSH host alias or `user@host`; plain words only."),
        wp_root: z.string().describe("The WordPress root on the server, absolute or relative to the login directory."),
        wp_cli: z.string().nullable().optional().describe("The command that runs WP-CLI as the site's user when it is not `wp`."),
        file_prefix: z.string().nullable().optional().describe("The prefix that runs a file command as the site's user; unused by the inventory."),
      }).nullable().optional().describe("How to reach the site's server. Omit to use the site file's `host` block."),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; server?: Parameters<typeof serverOf>[0] | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const site = apexOf(params.site);
      const environment = deps.environment ?? process.env;
      let output: InventoryOutput;
      if (environment[SERVER_GATHER_ENVIRONMENT] !== "1") {
        output = { site, inventory: { status: "unmeasured", reason: SERVER_OFF_REASON } };
      } else {
        const server =
          params.server == null
            ? (await siteContextForAddress(params.site, deps.sitesDirectory))?.security?.server
            : serverOf(params.server);
        const inspect = await measureWordpressInspect(server, run, {
          only: INVENTORY_COMMANDS,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(signal === undefined ? {} : { signal }),
        });
        const publicApi =
          inspect.status === "measured"
            ? { status: "measured" as const, releases: await readReleases(deps.net ?? systemSecurityNet, signal) }
            : undefined;
        output = await runInventory(
          { site, inspect, ...(publicApi === undefined ? {} : { public_api: publicApi }) },
          {
            prompt: promptFor,
            judge: ({ prompt, accept }) =>
              withHeartbeat(onUpdate, "judging the inventory", () => askJson(model, prompt, accept, { ...(signal === undefined ? {} : { signal }) })),
          },
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }], details: output };
    },
  };
}
