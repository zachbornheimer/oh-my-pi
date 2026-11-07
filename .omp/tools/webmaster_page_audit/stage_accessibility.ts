import { accessibilityFindings } from "./accessibility_rules.ts";
import type { Finding } from "./finding.ts";
import type { AccessibilityMeasurement } from "./measurement.ts";

export interface AccessibilityResult {
  url: string;
  findings: Finding[];
  unmeasured?: string;
}

/**
 * The accessibility of one live page: axe violations the probe read, grouped by impact into findings. The rules are
 * the contract; no model is asked. A page that could not be read returns no findings and the reason in `unmeasured`.
 */
export async function accessibilityStage(
  probes: { accessibility(url: string): Promise<AccessibilityMeasurement> },
  url: string,
): Promise<AccessibilityResult> {
  const page = await probes.accessibility(url);
  if (page.status === "unmeasured") return { url, findings: [], unmeasured: page.reason };
  return { url, findings: accessibilityFindings(page) };
}
