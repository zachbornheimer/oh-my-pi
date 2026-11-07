import type { Finding } from "./finding.ts";
import type { AccessibilityMeasurement, AxeImpact } from "./measurement.ts";

type Measured = Extract<AccessibilityMeasurement, { status: "measured" }>;

const BLOCKING: readonly AxeImpact[] = ["critical", "serious"];
const ADVISORY: readonly AxeImpact[] = ["moderate", "minor"];
const UNNAMED = "the probe did not name the elements";

const finding = (
  id: string,
  severity: Finding["severity"],
  evidence: string,
  fix_hint: string,
): Finding => ({ id: `accessibility.${id}`, area: "accessibility", severity, evidence, fix_hint });

/** `${impact}: ${help} (${id}, ${count} elements)`, the shape the webmaster CLI reports for one rule. */
function named(page: Measured, impacts: readonly AxeImpact[]): string {
  const lines = page.violations
    .filter((violation) => impacts.includes(violation.impact))
    .map((violation) => `${violation.impact}: ${violation.help} (${violation.id}, ${violation.node_count} elements)`);
  return lines.length > 0 ? lines.join("; ") : UNNAMED;
}

/**
 * Accessibility findings a rule can raise from one measured page. Critical and serious rules are one high finding;
 * moderate and minor are one medium finding. Pure: the same page always gives the same findings.
 */
export function accessibilityFindings(page: Measured): Finding[] {
  const { critical, serious, moderate, minor } = page.by_impact;
  const found: Finding[] = [];
  if (critical + serious > 0) {
    found.push(finding(
      "blocking",
      "high",
      `${critical} critical and ${serious} serious accessibility violations. ${named(page, BLOCKING)}`,
      "Fix the listed accessibility problems; the browser check names each element.",
    ));
  }
  if (moderate + minor > 0) {
    found.push(finding(
      "advisory",
      "medium",
      `${moderate} moderate and ${minor} minor accessibility violations. ${named(page, ADVISORY)}`,
      "Fix the moderate accessibility problems on this page.",
    ));
  }
  return found;
}
