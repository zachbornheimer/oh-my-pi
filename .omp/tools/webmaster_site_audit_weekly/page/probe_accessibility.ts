import { AXE_IMPACTS, type AccessibilityMeasurement, type AxeImpact, unmeasured } from "./measurement.ts";
import type { AxeViolation, PageOpener } from "./browser.ts";

/** How many axe rules fall at each impact. */
export function groupByImpact(violations: readonly AxeViolation[]): Record<AxeImpact, number> {
  const counts = Object.fromEntries(AXE_IMPACTS.map((impact) => [impact, 0])) as Record<AxeImpact, number>;
  for (const violation of violations) counts[violation.impact] += 1;
  return counts;
}

/**
 * axe-core violations on the rendered page, one per rule, grouped by impact. A browser that cannot open the page, or
 * a missing browser library, leaves the page unmeasured with the reason; it never throws for a page problem.
 */
export async function measureAccessibility(
  url: string,
  open: PageOpener,
  signal?: AbortSignal,
): Promise<AccessibilityMeasurement> {
  try {
    return await open(url, async (page): Promise<AccessibilityMeasurement> => {
      const violations = await page.axeViolations();
      return {
        status: "measured",
        final_url: page.finalUrl,
        violations: violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          node_count: violation.nodeCount,
        })),
        by_impact: groupByImpact(violations),
      };
    }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return unmeasured(`could not read accessibility of ${url}: ${reason}`);
  }
}
