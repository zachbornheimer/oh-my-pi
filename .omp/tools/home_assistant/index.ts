import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type HomeAssistantDeps, type HomeAssistantInput, runHomeAssistant } from "./home_assistant_core.ts";

/**
 * Native `home_assistant` custom tool: a port of the Mastra capability of the same name. Reads a Home Assistant
 * instance over its REST API, or renders a template with the instance's own Jinja engine. Self-contained: no Mastra,
 * no gateway. Differences from the Mastra twin: a failure throws (the tool result is an error) instead of answering
 * `{ error: true, message }`; each HTTP call times out after 30 s; an empty HASS_HOST no longer hides HASS_URL.
 */
const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Read a Home Assistant instance's live state, or render a Jinja template with the instance's own engine; use it to prove what a running automation sees, since `states()`, `has_value()` and `expand()` exist only there and a local Jinja2 render cannot prove them. "
  + "`{\"action\":\"config\"}` returns version, time_zone, location_name and core state. "
  + "`{\"action\":\"states\",\"domain\":\"counter\",\"search\":\"cam_heal\",\"limit\":50,\"attributes\":true}` lists entities filtered by domain (the part before the dot) and a case-insensitive entity-id substring; `limit` defaults to 200, the result carries `total` and `truncated`, and attributes are omitted unless `attributes` is true. "
  + "`{\"action\":\"state\",\"entity_id\":\"counter.garage_cam_heal_attempts\"}` returns one entity with its attributes. "
  + "`{\"action\":\"template\",\"template\":\"{{ states('counter.garage_cam_heal_attempts') }}\"}` returns the rendered text; a template error comes back as Home Assistant's own 500 message. "
  + "A field the chosen action does not read is refused. ONLY reads: NEVER calls a service or changes a device. "
  + "Env: HASS_HOST (else HASS_URL; http:// assumed when no scheme), HASS_TOKEN or HASS_TOKEN_FILE (`path#name` reads one line of a YAML secrets file), HASS_INSECURE_TLS=1 to accept the instance's own certificate; rendering needs an administrator's long-lived access token. "
  + "Each HTTP call times out after 30 s. A missing variable, HTTP error or reply of the wrong shape fails the call with the reason. The result is the JSON answer as text, also in `details`.";

type ToolApi = Parameters<CustomToolFactory>[0];

/** Build the tool; `deps` is the test seam (env, fetch, credential reader). Production passes none. */
export function buildTool(pi: ToolApi, deps: HomeAssistantDeps = {}) {
  const z = pi.zod;
  return {
    name: "home_assistant",
    label: "Home Assistant",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["config", "states", "state", "template"]).describe(
        "`config`: version, time zone, location, core state. `states`: list entities. `state`: one entity by `entity_id`. `template`: render `template`.",
      ),
      entity_id: z.string().min(1).nullable().optional().describe("`state` only: the entity to read, such as `counter.garage_cam_heal_attempts`."),
      domain: z.string().min(1).nullable().optional().describe("`states` only: keep entities of this domain, the part before the dot, such as `counter`."),
      search: z.string().min(1).nullable().optional().describe("`states` only: keep entities whose id contains this text, case-insensitively."),
      limit: z.number().int().positive().nullable().optional().describe("`states` only: at most this many rows, in Home Assistant's order. Default 200."),
      attributes: z.boolean().nullable().optional().describe("`states` only: include each row's attributes. Default false; `state` always includes them."),
      template: z.string().min(1).nullable().optional().describe("`template` only: the Jinja template to render."),
    }),

    async execute(
      _toolCallId: string,
      params: HomeAssistantInput,
      onUpdate: ((partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `home_assistant ${params.action} is waiting on the instance (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { action: params.action, status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const output = await runHomeAssistant(params, { ...deps, signal: signal ?? deps.signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
      } finally {
        clearInterval(beat);
      }
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
