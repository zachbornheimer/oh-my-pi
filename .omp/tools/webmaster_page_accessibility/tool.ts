import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { chromiumOpener, type PageOpener } from "./browser.ts";
import { measureAccessibility } from "./probe_accessibility.ts";
import { accessibilityStage } from "./stage_accessibility.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface AccessibilityToolDeps {
  /** Opens a page in a browser; the real Chromium opener when omitted. */
  open?: PageOpener;
}

export const DESCRIPTION =
  "Read one live page's accessibility in a headless Chromium with axe-core and return findings. Use webmaster_page_seo for search facts, webmaster_page_privacy for tracking and webmaster_page_audit for every area at once. "
  + "Input: `{\"url\":\"https://example.org/about\"}`. `url` MUST be an absolute http or https address; anything else is refused before a browser starts. "
  + "Opens the page in a fresh browser (15 to 60 s), waits 2 s after load, runs axe on the desktop viewport (1440x900) and closes the browser. The page's own scripts run; nothing is clicked, submitted or changed on the site. "
  + "Rules, no model: critical and serious violations are one high finding `accessibility.blocking`; moderate and minor ones are one medium finding `accessibility.advisory`; each names the axe rule, its impact, its help text and its element count. "
  + "Result: `{url, findings:[{id, area, severity, evidence, fix_hint}], unmeasured?}`. Empty `findings` with no `unmeasured` is a clean page. If the browser cannot open the page, or `playwright` and `@axe-core/playwright` are not installed in this tool's directory (run `bun install` there), `findings` is `[]` and `unmeasured` holds the reason: that is NOT a clean page.";

export function makeTool(pi: Pi, deps: AccessibilityToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_page_accessibility",
    label: "Page accessibility",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/about`."),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const open = deps.open ?? chromiumOpener();
      const result = await withHeartbeat(onUpdate, "Reading accessibility", () =>
        accessibilityStage({ accessibility: (address) => measureAccessibility(address, open, signal) }, url));
      return jsonResult(result);
    },
  };
}
