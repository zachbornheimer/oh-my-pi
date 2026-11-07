import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type SecurityCheckResult, answer } from "./check.ts";
import { CHECK, type DefacementInput, defacementVerdictBySight, type HomePage, visibleText } from "./defacement.ts";
import { ompImageStep } from "./image_model.ts";
import { apexOf, describeError, inBatches, publicGet, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { DROP_PATHS, drop, type SitePublicFiles } from "./public_files.ts";
import { type Exec, type ModelStep, withHeartbeat } from "./omp_model.ts";
import { measureScreenshot, type ScreenshotMeasurement } from "./screenshot.ts";
import { siteContextForAddress } from "./site_context.ts";

export interface DefacementToolDeps {
  net?: SecurityNet;
  /** Reads the home page; the default is a public GET that follows redirects. */
  getHome?: (url: string, signal?: AbortSignal) => Promise<{ status: number; body: string }>;
  /** Takes the picture; the default drives headless Chrome through `pi.exec` behind the destination gate. */
  screenshot?: (url: string, signal?: AbortSignal) => Promise<ScreenshotMeasurement>;
  /** The model step that reads the picture at `imagePath`; the default spawns `omp -p`. */
  imageStep?: (imagePath: string) => ModelStep;
  sitesDirectory?: string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Check whether a site shows a defacer's signature, and return pass, fail or unmeasured with findings. Use it after an alert or when a site looks wrong; it reads what is public and never fixes, deletes, quarantines, rotates or messages anyone. "
  + "Input: `{\"site\":\"example.org\"}`, optionally `defacement_patterns` (extra phrases, matched without case); omitted, they come from the matching site file's `security.defacement_patterns` under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`). "
  + "It GETs the home page and 7 drop pages (`/0x.html`, `/hacked.html`, `/index.html`...) to public addresses only, never POST. \"Hacked By\", \"H4ck3d By\", \"Defaced By\", \"Greetz to\" or a given phrase in the home page's text or a drop page is `security.site.defacement`, high, with no model call. Otherwise it launches headless Chrome (a fresh profile behind a gate that refuses private addresses; `WEBMASTER_CHROME` names the executable) for a 1280x800 picture and makes one billed `omp -p` call that reads it: a stated probability of 0.8 or more is high, 0.5 or more medium (self-reported, not calibrated). "
  + "Result: `{site, check, status, findings, reason?}`. A pass needs the home page text, the drop pages and the picture all read; any unread source, a missing browser, or a model that cannot read images is `unmeasured` with the reason, never a pass.";

/** Reads the home page over the public network, following redirects. */
const systemGetHome: NonNullable<DefacementToolDeps["getHome"]> = async (url, signal) => {
  const answered = await publicGet(url, {
    headers: { "user-agent": "omp-webmaster-defacement/1.0 (read-only check)" },
    timeoutMs: 20_000,
    bodyCap: 2_000_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: answered.status, body: answered.body };
};

async function readHome(url: string, getHome: NonNullable<DefacementToolDeps["getHome"]>, signal?: AbortSignal): Promise<HomePage> {
  try {
    const page = await getHome(url, signal);
    if (page.status >= 400) return { status: "unmeasured", reason: `HTTP ${page.status} at ${url}` };
    return { status: "measured", final_url: url, http_status: page.status, visible_text: visibleText(page.body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `${url} did not answer: ${describeError(error)}` };
  }
}

/** The drop pages only (the exposure paths are not this check's business); unmeasured when none answered. */
async function readDropPages(siteUrl: string, net: SecurityNet, signal?: AbortSignal): Promise<SitePublicFiles> {
  const files = await inBatches(DROP_PATHS, 6, (path) => drop(net, siteUrl, path, signal));
  if (files.every((file) => file.status === 0)) {
    return { status: "unmeasured", reason: `${siteUrl} did not answer: ${files[0]?.error ?? "no request was sent"}` };
  }
  return { status: "measured", files };
}

export function makeTool(pi: Pi, deps: DefacementToolDeps = {}) {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  return {
    name: "webmaster_security_site_defacement",
    label: "Defacement check",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`."),
      defacement_patterns: z.array(z.string()).nullable().optional().describe(
        "Extra phrases, matched without case, that mean the site was defaced. Omit to use the site file's `security.defacement_patterns`; `[]` for none.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; defacement_patterns?: string[] | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const siteUrl = siteUrlOf(params.site);
      const apex = apexOf(params.site);
      const patterns = params.defacement_patterns ?? (await siteContextForAddress(params.site, deps.sitesDirectory))?.security?.defacement_patterns ?? [];
      const net = deps.net ?? systemSecurityNet;
      const result = await withHeartbeat(onUpdate, "checking the home page, the drop pages and the picture", async (): Promise<SecurityCheckResult> => {
        const home = `${siteUrl}/`;
        const [homePage, publicFiles] = await Promise.all([readHome(home, deps.getHome ?? systemGetHome, signal), readDropPages(siteUrl, net, signal)]);
        const input: DefacementInput = { site: params.site, home_page: homePage, public_files: publicFiles, defacement_patterns: patterns };
        let held: ScreenshotMeasurement | undefined;
        try {
          const verdict = await defacementVerdictBySight(input, async () => {
            // A page that did not answer cannot be pictured; do not launch a browser for it.
            held = homePage.status !== "measured"
              ? { status: "unmeasured", reason: homePage.reason }
              : await (deps.screenshot ?? ((url, s) => measureScreenshot(url, { ...(s === undefined ? {} : { signal: s }) })))(home, signal);
            const imageStep = deps.imageStep ?? ((path: string) => ompImageStep(exec, path));
            return held.status === "measured" ? { screenshot: held, step: imageStep(held.path) } : { screenshot: held };
          }, signal);
          return answer(apex, CHECK, verdict);
        } finally {
          if (held?.status === "measured") await held.release().catch(() => undefined);
        }
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
