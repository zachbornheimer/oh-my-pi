import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { dailyPorts, type LiveDeps, livePorts } from "./live";
import type { Exec } from "./omp_model";
import { withHeartbeat } from "./omp_model";
import { checkSites, runSiteSecurity, type SecurityRun, type SiteSecurityPorts } from "./site_security";

export const NAME = "webmaster_site_security_daily";

export const DESCRIPTION =
  "Check the security of every configured website from outside, one after another, with the 22 checks of `webmaster_site_security`: DNS (dangling CNAMEs, SPF, DMARC, DKIM), TLS (expiry, host name, trust, origin mismatch), public files (exposed files, defacement), the WordPress public API and, only when `WEBMASTER_SECURITY_SERVER=1`, a read-only WP-CLI inspection over SSH. "
  + "Use it for the daily sweep (the Mastra schedule ran it at 06:30); for one site or per-site overrides call `webmaster_site_security`. "
  + "Input: `{}` for every site file under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`) whose `capabilities` list `security`, or `{\"sites\":[\"isjac\"]}` for named site files. "
  + "Result: `{sites:[{site,status:\"checked\",result:{site,checks,findings,unmeasured}}|{site,status:\"failed\",error}],totals}`; `totals` counts findings by severity; findings are worst first with `containment` and `fix_hint`. A site that fails is recorded and the rest run; a check whose data could not be read is `unmeasured`, NEVER pass. "
  + "Per site it sends DNS queries, TLS handshakes and dozens of public requests, launches headless Chrome and may make one billed `omp -p` call that reads the home page picture; it never fixes, deletes, quarantines, rotates or messages anyone, and it does not schedule itself.";

type Pi = Parameters<CustomToolFactory>[0];

export interface Params {
  sites?: string[] | null;
}

export interface ToolDeps extends Partial<Omit<LiveDeps, "exec">> {
  /** Replaces the live collection ports entirely; tests pass recorded ones. */
  ports?: SiteSecurityPorts;
}

export function makeTool(pi: Pi, deps: ToolDeps = {}) {
  const z = pi.zod;
  const live: LiveDeps = { exec: pi.exec as unknown as Exec, ...deps };
  const ports = deps.ports ?? livePorts(live);
  return {
    name: NAME,
    label: "Daily site security",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    parameters: z.object({
      sites: z.array(z.string().trim().min(1)).min(1).nullable().optional().describe(
        "Site file names under the webmaster sites directory; every site file whose capabilities list `security` when absent.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Params,
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const note = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "running" } });
      const names = params.sites == null ? undefined : [...new Set(params.sites.map((site) => site.trim()))];
      const run: SecurityRun = await withHeartbeat(onUpdate, "Checking site security", () =>
        checkSites(names, dailyPorts(live, (address, progress) => runSiteSecurity(address, ports, {}, signal, progress)), signal, note));
      return { content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }], details: run };
    },
  };
}
