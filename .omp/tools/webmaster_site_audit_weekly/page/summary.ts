import type { Finding, Severity } from "./finding.ts";
import type { Health } from "./ranking.ts";

/** One line saying how the page is: its health, how many findings at each severity, and the one to fix first. */
export function auditHeadline(
  subject: string,
  health: Health,
  counts: Readonly<Record<Severity, number>>,
  first: Finding | undefined,
): string {
  const tally = (["high", "medium", "low"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");
  const lead = `${subject}: ${health.replace("_", " ")}`;
  if (first === undefined) return `${lead}, no findings.`;
  return `${lead}; ${tally === "" ? "info only" : tally}. Fix first: ${first.id}.`;
}
