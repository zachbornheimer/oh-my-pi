import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type AuditInput, auditSites, type SiteAuditPorts } from "./audit";
import { type AuditDeps, liveAuditPorts } from "./live";
import { type Exec, withHeartbeat } from "./sitemap/omp_model";

export const NAME = "webmaster_site_audit_weekly";

export const DESCRIPTION =
  "Audit every configured website, one after another, with three read-only measurements each: the site security check (22 checks: DNS, TLS, public files, WordPress public API, defacement), the sitemap check (addresses the sitemap lists that it should not) and a page audit of each site's declared key URLs (at most 8; the rest are counted in `pagesTruncated`). "
  + "Use it for the weekly review or after a change to a site; for one measurement, call `webmaster_site_security` or `webmaster_sitemap`; it never fixes, files, deletes or messages anyone. "
  + "Input: `{}` for every site file under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`), or `{\"sites\":[\"isjac\"]}`; `research` (default false) asks the page audit for analog pages and a world-class synthesis, which a billed model quota can miss. "
  + "Result: `{sites:[{site,url,status,security,sitemap,pages[],pagesTruncated?}],totals,research}`; `totals` counts findings by severity; a site, check or page that fails is recorded as `{status:\"failed\",error}` and the run continues. "
  + "The sitemap check makes one billed `omp -p` call per site, and the security check launches headless Chrome and may make one more billed call; the server inspection runs only with `WEBMASTER_SECURITY_SERVER=1`. "
  + "The page audit takes 2 to 10 minutes per page and opens headless Chromium for accessibility and privacy (needs `playwright` and `@axe-core/playwright` installed in this tool's directory), so a full run is slow.";

type Pi = Parameters<CustomToolFactory>[0];

export interface Params {
  sites?: string[] | null;
  research?: boolean | null;
}

export interface ToolDeps extends Partial<Omit<AuditDeps, "exec">> {
  /** Replaces the live ports entirely; tests pass fakes. */
  ports?: SiteAuditPorts;
}

export function makeTool(pi: Pi, deps: ToolDeps = {}) {
  const z = pi.zod;
  const ports = deps.ports ?? liveAuditPorts({ exec: pi.exec as unknown as Exec, zod: pi.zod as never, ...deps });
  return {
    name: NAME,
    label: "Site audit",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    parameters: z.object({
      sites: z.array(z.string().trim().min(1)).min(1).nullable().optional().describe(
        "Site file names under the webmaster sites directory, such as `isjac`; every site file when absent.",
      ),
      research: z.boolean().nullable().optional().describe(
        "Run analog pages and the world-class synthesis in each page audit. Default false.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Params,
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const input: AuditInput = {
        ...(params.sites == null ? {} : { sites: params.sites.map((site) => site.trim()) }),
        ...(params.research == null ? {} : { research: params.research }),
      };
      const note = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "running" } });
      const audit = await withHeartbeat(onUpdate, "Auditing sites", () => auditSites(input, ports, signal, note));
      return { content: [{ type: "text" as const, text: JSON.stringify(audit, null, 2) }], details: audit };
    },
  };
}
