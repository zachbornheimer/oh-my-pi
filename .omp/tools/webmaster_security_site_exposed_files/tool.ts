import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, type SecurityCheckResult } from "./check.ts";
import { CHECK, exposedVerdict } from "./exposed_files.ts";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { measurePublicFiles, validatedExposurePaths } from "./public_files.ts";
import { siteContextForAddress } from "./site_context.ts";

export interface ExposedFilesToolDeps {
  net?: SecurityNet;
  /** Where the owner's site files are; the default is `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites`. */
  sitesDirectory?: string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Check whether a site serves files that should never be public, and return pass, fail or unmeasured with findings. Use it for a verdict on exposed `.env`, `.git`, database dumps, backups, `phpinfo.php`, logs and directory listings; use webmaster_site_public_files for the raw reading. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://example.org/\",\"exposure_paths\":[\"/old-site.zip\"]}`. `site` is a domain or address. `exposure_paths` adds site paths (each starting with a single `/`, at most 50) to the 17 built-in ones; omitted, they come from the matching site file's `security.exposure_paths` under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`). "
  + "It fetches first: about 24 GET requests, 6 at a time, 15 s each, to public addresses only (never POST, no redirects followed), then judges. A path that answered 2xx with content is flagged as `security.site.exposed_files`: high when its name is a dump, environment file, git repository, log or phpinfo page, or its content is credentials, PHP source, a dump, git metadata, phpinfo or a debug log; medium for an archive, backup or directory listing. "
  + "Result: `{site, check, status, findings, reason?}`; each finding has `id`, `severity`, `evidence` (paths and what they served, never the content), `containment` and `fix_hint`. `unmeasured` (with `reason`) when no exposure path answered at all. It never fixes, deletes, quarantines, rotates or messages anyone.";

export function makeTool(pi: Pi, deps: ExposedFilesToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_security_site_exposed_files",
    label: "Exposed files check",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`."),
      exposure_paths: z.array(z.string()).nullable().optional().describe(
        "Extra site paths to ask for besides the built-in list, each starting with `/` (at most 50). Omit to use the site file's `security.exposure_paths`; `[]` for none.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; exposure_paths?: string[] | null },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const siteUrl = siteUrlOf(params.site);
      const apex = apexOf(params.site);
      const given = params.exposure_paths ?? undefined;
      const exposurePaths = validatedExposurePaths(
        given ?? (await siteContextForAddress(params.site, deps.sitesDirectory))?.security?.exposure_paths ?? [],
      );
      const publicFiles = await measurePublicFiles({ siteUrl, exposurePaths }, deps.net ?? systemSecurityNet, signal);
      const result: SecurityCheckResult = answer(apex, CHECK, exposedVerdict(publicFiles));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
