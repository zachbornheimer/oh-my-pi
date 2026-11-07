import type { Check, Entry, Facts } from "./schemas.js";

// Port of agentmux internal/depupgrade/callsites.go. CallSitesSection is the PR-body Markdown that shows a
// reviewer where this repository uses each bumped package and which changelog entries apply; callSitesReviewed
// is the criterion that the body names those call sites or holds that section.

const CALL_SITES_HEADING = "### Call sites";

// Go's strings.Fields: split on runs of Unicode whitespace (unicode.IsSpace is the White_Space property).
const WHITESPACE_RUN = /\p{White_Space}+/u;

/** Go's `strings.Fields`: the non-empty words of `text`, any run of whitespace between them dropped. */
function fields(text: string): string[] {
  return text.split(WHITESPACE_RUN).filter((word) => word !== "");
}

/**
 * The Markdown `### Call sites` section listing every importer of each bumped package and the changelog
 * entries that apply, as `prBody` embeds it (`CallSitesSection` in callsites.go).
 */
export function CallSitesSection(facts: Facts): string {
  let out = `${CALL_SITES_HEADING}\n\n`;
  for (const packageFacts of facts.packages) {
    const { name, from, to } = packageFacts.package;
    out += `#### \`${name}\` ${from} → ${to}\n\n`;
    if (packageFacts.importers.length === 0) out += "- no file imports it directly\n";
    for (const path of packageFacts.importers) out += `- \`${path}\`\n`;
    if (packageFacts.matched_entries.length > 0) out += "\nChangelog entries that apply here:\n\n";
    for (const entry of packageFacts.matched_entries) out += `${entryLine(entry)}\n`;
    out += "\n";
  }
  return out;
}

/** One applicable changelog entry, its text's whitespace runs collapsed to single spaces. */
function entryLine(entry: Entry): string {
  return `- ${entry.version} (${entry.kind}): ${fields(entry.text).join(" ")}`;
}

/**
 * The call-sites criterion: passes when the PR body names every importer, or holds the call-sites section
 * Repair writes (`callSitesReviewed` in callsites.go).
 */
export function callSitesReviewed(facts: Facts, body: string): Check {
  let total = 0;
  let named = 0;
  for (const packageFacts of facts.packages) {
    for (const path of packageFacts.importers) {
      total += 1;
      if (body.includes(path)) named += 1;
    }
  }
  const observed = `${total} importers, ${named} named in the PR body`;
  if (total === 0) return { name: "call_sites_reviewed", verdict: "passed", observed };
  if (named === total || body.includes(CallSitesSection(facts))) {
    return { name: "call_sites_reviewed", verdict: "passed", observed };
  }
  return { name: "call_sites_reviewed", verdict: "failed", observed };
}
