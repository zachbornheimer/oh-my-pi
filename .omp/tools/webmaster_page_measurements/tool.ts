import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_PAGE_PROBES,
  FORM_FACTORS,
  type FormFactor,
  PAGE_PROBES,
  type PageProbe,
  VISIBLE_TEXT_CAP,
} from "./measurement.ts";
import type {
  ContentMeasurement,
  PerformanceMeasurement,
  ScreenshotMeasurement,
  SeoMeasurement,
} from "./measurement.ts";
import { measureContent } from "./probe_content.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { measureScreenshot, screenshotDirectory } from "./probe_screenshot.ts";
import { measureSeo } from "./probe_seo.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

/** The page probes this tool runs; each returns a measurement, never throws for a page problem. */
export interface MeasurementProbes {
  seo(url: string): Promise<SeoMeasurement>;
  content(url: string): Promise<ContentMeasurement>;
  performance(url: string, formFactor: FormFactor): Promise<PerformanceMeasurement>;
  screenshot(url: string): Promise<ScreenshotMeasurement>;
}

export interface MeasurementsToolDeps {
  /** The probes; the real ones (GET, PageSpeed or Lighthouse, headless browser) when omitted. */
  probes?: MeasurementProbes;
  host?: PerformanceHost;
  /** Where screenshots are kept; `$OMP_WEBMASTER_SCREENSHOT_DIR` or `~/.cache/omp-webmaster/screenshots` when omitted. */
  screenshotDirectory?: string;
}

export const DESCRIPTION =
  "Read one live page with the page probes and return the raw measurements, not findings: `seo` (title, meta, canonical, robots, headings, schema, Open Graph, link counts), `content` (visible text, analytics tags, third-party hosts, image alt counts, generator), `performance` (PageSpeed or local Lighthouse metrics) and `screenshot` (a PNG of the first 1280x800 viewport). Use webmaster_page_seo or webmaster_page_performance when you want findings and webmaster_page_audit for the whole page. "
  + "Input: `{\"url\":\"https://example.org/\"}` or `{\"url\":\"https://example.org/\",\"probes\":[\"seo\",\"performance\"],\"form_factor\":\"desktop\"}`. `url` MUST be an absolute http or https address. `probes` defaults to `[\"seo\",\"content\"]`; add `performance` (30 s to 4 min; PageSpeed with `PSI_API_KEY` or keychain `psi-api-key`, else `bunx lighthouse` launching Chrome) or `screenshot` (headless Chromium, needs `playwright` installed in this tool's directory). `form_factor` is `mobile` (default) or `desktop` and only affects `performance`. "
  + `Probes run at once. Each page request is a GET; a screenshot renders the page with its scripts but refuses any request to a private, loopback or link-local address, saves a PNG named by its SHA-256 (kept 7 days) and returns its path, hash and size. Visible text is capped at ${VISIBLE_TEXT_CAP} characters. Changes nothing on the site. `
  + "Result: `{url, measurements:{<probe>: {status:\"measured\", ...} | {status:\"unmeasured\", reason}}}` with one entry per asked probe. A page or quota problem is `unmeasured` with its reason, never an error; an unmeasured probe is NOT a clean reading.";

export function makeTool(pi: Pi, deps: MeasurementsToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_page_measurements",
    label: "Page measurements",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/`."),
      probes: z.array(z.enum(PAGE_PROBES)).nullable().optional().describe(
        "Probes to run: `seo`, `content`, `performance` (slow), `screenshot`. Default `[\"seo\",\"content\"]`.",
      ),
      form_factor: z.enum(FORM_FACTORS).nullable().optional().describe(
        "Device profile for `performance`: `mobile` (default) or `desktop`.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string; probes?: PageProbe[] | null; form_factor?: FormFactor | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const formFactor: FormFactor = params.form_factor ?? "mobile";
      const asked = [...new Set(params.probes ?? DEFAULT_PAGE_PROBES)];
      const host = deps.host ?? systemHost;
      const probes: MeasurementProbes = deps.probes ?? {
        seo: (address) => measureSeo(address, signal),
        content: (address) => measureContent(address, signal),
        performance: (address, factor) => measurePerformance(host, address, factor, signal),
        screenshot: (address) =>
          measureScreenshot(address, {
            directory: deps.screenshotDirectory ?? screenshotDirectory(),
            ...(signal === undefined ? {} : { signal }),
          }),
      };
      const read = (probe: PageProbe) => probe === "performance" ? probes.performance(url, formFactor) : probes[probe](url);
      const readings = await withHeartbeat(onUpdate, "Reading the page", () =>
        Promise.all(asked.map(async (probe) => [probe, await read(probe)] as const)));
      return jsonResult({ url, measurements: Object.fromEntries(readings) });
    },
  };
}
