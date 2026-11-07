import type { PageOpener } from "./browser.ts";
import { type ConsentGate, type PrivacyMeasurement, unmeasured } from "./measurement.ts";

/** Hosts that record a visit. A request to one of these before a click is pre-consent tracking. */
export const TRACKER_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.net",
  "hotjar.com",
  "hs-analytics.net",
] as const;

/**
 * Markers the webmaster CLI treats as a consent banner. None of them in the HTML means the gate is absent.
 * A banner that is present but does not block the tracker hosts still lets them fire before a click.
 */
const CONSENT_MARKERS = [
  "cookie-notice",
  "cookiebot",
  "complianz",
  "cmplz",
  "onetrust",
  "cookieyes",
  "iubenda",
  "borlabs",
  "cookie-law-info",
  "termly",
  "consent-banner",
] as const;

/**
 * Tracker hosts among the requests the page issued before any click. A URL that does not parse is ignored.
 * `www.googletagmanager.com` and `googletagmanager.com` count once, as the registrable tracker host.
 */
export function trackerHosts(urls: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of urls) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    const match = TRACKER_HOSTS.find((tracker) => host === tracker || host.endsWith(`.${tracker}`));
    if (match !== undefined) found.add(match);
  }
  return [...found];
}

/** `absent` when the page HTML carries none of the known consent-banner markers. */
export function consentGate(html: string): ConsentGate {
  const lower = html.toLowerCase();
  return CONSENT_MARKERS.some((marker) => lower.includes(marker)) ? "present" : "absent";
}

/**
 * Tracker hosts the page requests before any click, and whether a consent gate is in the HTML. The browser records
 * requests from navigation; nothing is clicked. A browser that cannot open the page leaves it unmeasured.
 */
export async function measurePrivacy(url: string, open: PageOpener, signal?: AbortSignal): Promise<PrivacyMeasurement> {
  try {
    return await open(url, async (page): Promise<PrivacyMeasurement> => {
      const html = await page.html();
      return {
        status: "measured",
        final_url: page.finalUrl,
        tracker_hosts: trackerHosts(page.requestUrls()),
        consent_gate: consentGate(html),
      };
    }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return unmeasured(`could not read privacy of ${url}: ${reason}`);
  }
}
