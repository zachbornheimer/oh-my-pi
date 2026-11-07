import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type SentryDeps, type SentryInput, runSentry } from "./sentry_core.ts";

/**
 * Native `sentry` custom tool: a port of the Mastra capability of the same name. Calls the Sentry REST API with the
 * omp process's SENTRY_AUTH_TOKEN. Self-contained: no Mastra, no gateway. Differences from the Mastra twin: a failure
 * throws instead of answering `{ error: true, message }`; list_issues sends Sentry's `limit` parameter (the twin sent
 * `perPage`, which that endpoint does not read); an empty `query` is forwarded; list results say `has_more`; the
 * secret half of a DSN is not returned; each call times out after 30 s.
 */
const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Call the Sentry REST API to triage production errors, find a project's public DSN, or create a project. "
  + "`{\"action\":\"list_projects\"}` lists the org's projects (first page, up to 100). "
  + "`{\"action\":\"list_issues\",\"project\":\"isa-dashboard\",\"query\":\"is:unresolved\",\"limit\":10}` lists issues: `project` is a slug, `limit` is 1-100 (default 20), omitting `query` applies Sentry's default `is:unresolved`, and `\"query\":\"\"` returns every status. "
  + "`{\"action\":\"list_keys\",\"project\":\"isa-dashboard\"}` returns the project's keys with their public DSNs; the secret DSN is never returned. "
  + "`{\"action\":\"create_project\",\"name\":\"isa dashboard\",\"platform\":\"javascript-nextjs\"}` creates a project (`platform` optional) and returns it with its keys: call it ONLY when the user asked for a new project, because repeating it creates a duplicate. "
  + "The org is SENTRY_ORG, else software-automation-holdings-l. Auth is SENTRY_AUTH_TOKEN (org:read, project:read, project:write) in the omp process environment; it is never echoed. "
  + "List results carry `has_more` when Sentry has another page; later pages are NOT fetched. Each HTTP call times out after 30 s. A missing token, HTTP error or reply of the wrong shape fails the call; when a project was created but its keys could not be read, the error says so. "
  + "Calls the network; only `create_project` writes. The result is the JSON answer as text, also in `details`.";

type ToolApi = Parameters<CustomToolFactory>[0];

/** Build the tool; `deps` is the test seam (env, fetch). Production passes none. */
export function buildTool(pi: ToolApi, deps: SentryDeps = {}) {
  const z = pi.zod;
  return {
    name: "sentry",
    label: "Sentry",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["list_projects", "create_project", "list_keys", "list_issues"]).describe(
        "`list_projects`; `create_project` (needs `name`); `list_keys` (needs `project`); `list_issues` (needs `project`).",
      ),
      name: z.string().min(1).nullable().optional().describe("`create_project` only: the new project's name."),
      platform: z.string().min(1).nullable().optional().describe("`create_project` only: platform slug, such as `javascript-nextjs`. Omit to leave it unset."),
      project: z.string().min(1).nullable().optional().describe("`list_keys` and `list_issues`: the project slug."),
      query: z.string().nullable().optional().describe("`list_issues` only: Sentry search query, such as `is:unresolved`. Omit for Sentry's default `is:unresolved`; empty string for all issues."),
      limit: z.number().int().min(1).max(100).nullable().optional().describe("`list_issues` only: at most this many issues, 1-100. Default 20."),
    }),

    async execute(
      _toolCallId: string,
      params: SentryInput,
      onUpdate: ((partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `sentry ${params.action} is waiting on Sentry (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { action: params.action, status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const output = await runSentry(params, { ...deps, signal: signal ?? deps.signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
      } finally {
        clearInterval(beat);
      }
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
