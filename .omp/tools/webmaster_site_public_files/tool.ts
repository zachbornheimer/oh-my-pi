import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { measurePublicFiles, type SitePublicFiles, validatedExposurePaths } from "./public_files.ts";
import { siteContextForAddress } from "./site_context.ts";

export interface PublicFilesToolDeps {
  net?: SecurityNet;
  /** Where the owner's site files are; the default is `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites`. */
  sitesDirectory?: string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Ask a site for paths that should never serve content (`/.env`, `/.git/HEAD`, backups, `phpinfo.php`, `wp-config.php.bak`, directory listings) and for page names defacers drop (`/0x.html`, `/hacked.html`, ...), and record what each answered. "
  + "Use it for the raw reading; judge it with webmaster_security_site_exposed_files (exposure findings) or webmaster_security_site_defacement. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://example.org/\",\"exposure_paths\":[\"/old-site.zip\"]}`. `site` is a domain or address (only its origin is asked). `exposure_paths` adds site paths (each starting with a single `/`, at most 50) to the 17 built-in ones; omitted, the extra paths come from the matching site file's `security.exposure_paths` under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`), else none. "
  + "Sends about 24 GET requests, 6 at a time, 15 s each, to public addresses only (loopback, private and link-local targets are refused); never POST, never follows redirects. Read-only. "
  + "Result: `{site, public_files}`; `public_files` is `measured` with `files[]` (`purpose`, `method`, `path`, `status`, `content_type`, `body`, `exposed?`, `error?`) or `unmeasured` with a reason when no path answered. An exposure path keeps only a label of what it served (`exposed`), never its body; a drop page keeps its body with secret-looking values redacted. An unparsable `site` or bad path is refused.";

export function makeTool(pi: Pi, deps: PublicFilesToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_site_public_files",
    label: "Site public files",
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
      const publicFiles: SitePublicFiles = await measurePublicFiles({ siteUrl, exposurePaths }, deps.net ?? systemSecurityNet, signal);
      const result = { site: apex, public_files: publicFiles };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
