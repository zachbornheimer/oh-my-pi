import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { chromiumOpener, type PageOpener } from "./browser.ts";
import { measurePrivacy, TRACKER_HOSTS } from "./probe_privacy.ts";
import { privacyStage } from "./stage_privacy.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface PrivacyToolDeps {
  /** Opens a page in a browser; the real Chromium opener when omitted. */
  open?: PageOpener;
}

export const DESCRIPTION =
  "Load one live page in a headless Chromium and report the tracker hosts it requests before any click. Use webmaster_page_accessibility for axe findings and webmaster_page_audit for every area at once. "
  + "Input: `{\"url\":\"https://example.org/\"}`. `url` MUST be an absolute http or https address; anything else is refused before a browser starts. "
  + `Opens the page in a fresh browser (15 to 60 s), records every request from navigation start, waits 2 s after load and closes the browser; nothing is clicked or accepted, but the page's own scripts run and its tracking requests really go out. A tracker is a request to ${TRACKER_HOSTS.join(", ")} or a subdomain of one. `
  + "A rule, no model: one high finding `privacy.pre_consent_trackers` naming the hosts, noting when no consent banner marker (Cookiebot, Complianz, OneTrust, CookieYes and similar) is in the HTML. A banner in the HTML does not clear it: the requests fired anyway. No tracker request is a clean page, banner or not. "
  + "Result: `{url, findings:[{id, area, severity, evidence, fix_hint}], unmeasured?}`. If the browser cannot open the page, or `playwright` is not installed in this tool's directory (run `bun install` there), `findings` is `[]` and `unmeasured` holds the reason: that is NOT a clean page.";

export function makeTool(pi: Pi, deps: PrivacyToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_page_privacy",
    label: "Page pre-consent trackers",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/`."),
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
      const result = await withHeartbeat(onUpdate, "Reading trackers", () =>
        privacyStage({ privacy: (address) => measurePrivacy(address, open, signal) }, url));
      return jsonResult(result);
    },
  };
}
