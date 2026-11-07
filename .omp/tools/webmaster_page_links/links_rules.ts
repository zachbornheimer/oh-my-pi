import type { Finding } from "./finding.ts";
import type { LinksMeasurement } from "./measurement.ts";

type Measured = Extract<LinksMeasurement, { status: "measured" }>;

/** One finding when the page has broken internal links; none when every checked link answered. */
export function linksFindings(page: Measured): Finding[] {
  if (page.broken.length === 0) return [];
  const listed = page.broken.map((link) => link.url).join("; ");
  return [{
    id: "links.broken_internal",
    area: "links",
    severity: "high",
    evidence: `${page.broken.length} broken internal link(s) on this page: ${listed}`,
    fix_hint: "Fix or remove each broken internal link.",
  }];
}
