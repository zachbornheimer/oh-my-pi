import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type UnifiDeps, type UnifiInput, runUnifi } from "./unifi_core.ts";

/**
 * Native `unifi` custom tool: a port of the Mastra capability of the same name. Reads a UniFi console over its
 * Integration and classic APIs and can power-cycle one switch port. Self-contained: no Mastra, no gateway.
 * Differences from the Mastra twin: a failure throws instead of answering `{ error: true, message }`; `ports` and
 * `traffic` read the classic table of the site named by `site`/UNIFI_SITE (the twin always read `default`); a switch
 * is identified by id, MAC or name when two share a name; each HTTP call times out after 30 s; `traffic` streams a
 * heartbeat while it waits.
 */
const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Ask a UniFi console what its devices report, or power-cycle one PoE switch port. "
  + "Reads: `{\"action\":\"sites\"}`; `{\"action\":\"devices\",\"site\":\"Home\"}`; `{\"action\":\"cameras\"}` (Protect's own state, last_seen_ms, up_since_ms, firmware); "
  + "`{\"action\":\"ports\",\"device\":\"Garage Switch\",\"port\":5}` (per port: up, speed, PoE watts, cumulative rx/tx bytes, error and drop counters, link_down_count). "
  + "`{\"action\":\"traffic\",\"device\":\"Garage Switch\",\"port\":5,\"window_seconds\":25}` reads the ports twice, `window_seconds` apart (5-120, default 20), and returns per-port rates plus a verdict: `streaming`, `silent` (up but below `threshold_kbit`, default 1000, the line between a hung camera and a recording one), `link_down` or `unknown`. "
  + "`site` and `device` take an id, MAC or name; an unknown or ambiguous one is refused with the candidates. `ports` and `traffic` read the classic table of the site named by `site` or UNIFI_SITE (`default` when neither is set). "
  + "`{\"action\":\"power_cycle_port\",\"device\":\"Garage Switch\",\"port\":5}` physically cuts and restores PoE power on that port: call it ONLY when the user asked, once. It checks the index against the switch's port table first, never retries, and returns the console's status; confirm recovery with `traffic`. "
  + "Env: UNIFI_HOST (https:// assumed), UNIFI_API_KEY or UNIFI_API_KEY_FILE (`path#name` reads one line of a YAML secrets file), UNIFI_SITE, UNIFI_INSECURE_TLS=1. Each HTTP call times out after 30 s. A missing variable, HTTP error or reply of the wrong shape fails the call with the reason. "
  + "The result is the JSON answer as text, also in `details`.";

type ToolApi = Parameters<CustomToolFactory>[0];
type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Build the tool; `deps` is the test seam (env, fetch, clock, credential reader). Production passes none. */
export function buildTool(pi: ToolApi, deps: UnifiDeps = {}) {
  const z = pi.zod;
  return {
    name: "unifi",
    label: "UniFi",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["sites", "devices", "cameras", "ports", "traffic", "power_cycle_port"]).describe(
        "`sites`, `devices`, `cameras`, `ports`, `traffic` read the console; `power_cycle_port` (needs `device` and `port`) writes.",
      ),
      site: z.string().min(1).nullable().optional().describe("Site id, MAC or name. Default: UNIFI_SITE, else the only site the console lists."),
      device: z.string().min(1).nullable().optional().describe("Switch id, MAC or name: `ports` and `traffic` filter by it; `power_cycle_port` requires it."),
      port: z.number().int().min(1).max(64).nullable().optional().describe("Port index, 1-based. Required by `power_cycle_port`; filters `ports` and `traffic`."),
      window_seconds: z.number().int().min(5).max(120).nullable().optional().describe("`traffic` only: seconds between the two reads, 5-120. Default 20."),
      threshold_kbit: z.number().positive().nullable().optional().describe("`traffic` only: kbit/s at or above which an up port reads `streaming`. Default 1000."),
    }),

    async execute(
      _toolCallId: string,
      params: UnifiInput,
      onUpdate: Update | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `unifi ${params.action} is waiting on the console (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { action: params.action, status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const output = await runUnifi(params, {
          ...deps,
          signal: signal ?? deps.signal,
          progress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { action: params.action, status: "running" } }),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
      } finally {
        clearInterval(beat);
      }
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
