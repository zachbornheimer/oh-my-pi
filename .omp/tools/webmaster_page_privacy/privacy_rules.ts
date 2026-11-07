import type { Finding } from "./finding.ts";
import type { PrivacyMeasurement } from "./measurement.ts";

type Measured = Extract<PrivacyMeasurement, { status: "measured" }>;

const BLOCK_UNTIL_ACCEPT = "Block these hosts until the visitor accepts.";

/**
 * One finding when tracker hosts were requested before any click. Zero trackers is clean, even with no banner:
 * nothing fired. A banner that did not block the requests does not clear the finding.
 */
export function privacyFindings(page: Measured): Finding[] {
  if (page.tracker_hosts.length === 0) return [];
  const gate = page.consent_gate === "absent" ? " No consent gate on the page." : "";
  return [{
    id: "privacy.pre_consent_trackers",
    area: "privacy",
    severity: "high",
    evidence: `Trackers fire before consent: ${page.tracker_hosts.join(", ")}.${gate}`,
    fix_hint: BLOCK_UNTIL_ACCEPT,
  }];
}
