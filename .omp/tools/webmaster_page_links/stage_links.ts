import type { Finding } from "./finding.ts";
import { linksFindings } from "./links_rules.ts";
import type { LinksMeasurement } from "./measurement.ts";

export interface LinksResult {
  url: string;
  /** How many internal links were fetched; absent when the page was not measured. */
  checked?: number;
  /** True when the page has more internal links than were fetched, so a clean result covers only the first `checked`. */
  truncated?: boolean;
  findings: Finding[];
  unmeasured?: string;
}

/** Broken internal links on one live page. A 4xx or 5xx is broken; the rule is the contract, so no model is asked. */
export async function linksStage(
  probes: { links(url: string): Promise<LinksMeasurement> },
  url: string,
): Promise<LinksResult> {
  const page = await probes.links(url);
  if (page.status === "unmeasured") return { url, findings: [], unmeasured: page.reason };
  return { url, checked: page.checked, truncated: page.truncated, findings: linksFindings(page) };
}
