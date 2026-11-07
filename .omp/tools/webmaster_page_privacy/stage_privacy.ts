import type { Finding } from "./finding.ts";
import type { PrivacyMeasurement } from "./measurement.ts";
import { privacyFindings } from "./privacy_rules.ts";

export interface PrivacyResult {
  url: string;
  findings: Finding[];
  unmeasured?: string;
}

/**
 * Trackers that fire before consent on one live page. A request to a tracker host before any click is the finding.
 * The rule is the contract, so no model is asked.
 */
export async function privacyStage(
  probes: { privacy(url: string): Promise<PrivacyMeasurement> },
  url: string,
): Promise<PrivacyResult> {
  const page = await probes.privacy(url);
  if (page.status === "unmeasured") return { url, findings: [], unmeasured: page.reason };
  return { url, findings: privacyFindings(page) };
}
