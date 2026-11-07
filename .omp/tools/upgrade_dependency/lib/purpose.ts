import type { Entry } from "./schemas.js";

// Port of agentmux internal/depupgrade/purpose.go: why a model is asked during an upgrade (a closed set),
// the names of the deterministic stages, and the one line a prompt shows of a changelog entry. Mastra's question
// files, step timing and run-recording hooks belong to its runtime and are not ported.

/** Why a model is asked during an upgrade. The set is closed: each is one model step (Purpose). */
export const PURPOSES = {
  /** The replica's own step: agentmux gathers the changelog and advisories deterministically. */
  sources: "sources",
  applicableEntries: "applicable_entries",
  testStrictness: "test_strictness",
  prBody: "pr_body",
  facadePlan: "facade_plan",
} as const;

export type Purpose = (typeof PURPOSES)[keyof typeof PURPOSES];

/** Step names for the deterministic stages of a run (StepJudge, StepRepairBaseline). */
export const STEP_JUDGE = "judge";
export const STEP_REPAIR_BASELINE = "repair_baseline";

/** How much of one changelog entry a prompt quotes (promptEntryRunes). */
export const PROMPT_ENTRY_RUNES = 1500;

// Go's `strings.Fields`: split on runs of Unicode White_Space, keeping no empty words.
const WHITESPACE_RUN = /\p{White_Space}+/u;

/** Go's `strings.Join(strings.Fields(text), " ")`: the words of `text` joined by single spaces. */
export function collapseFields(text: string): string {
  return text.split(WHITESPACE_RUN).filter((word) => word !== "").join(" ");
}

/** At most `max` runes of `text`, followed by `ellipsis` when it was longer (Go's rune truncation). */
export function cutRunes(text: string, max: number, ellipsis = "..."): string {
  const runes = Array.from(text);
  return runes.length > max ? `${runes.slice(0, max).join("")}${ellipsis}` : text;
}

/** One changelog entry as a prompt shows it (entryLine): `version (kind, from source): text`. */
export function entryLine(entry: Entry): string {
  return `${entry.version} (${entry.kind}, from ${entry.source}): ${
    cutRunes(collapseFields(entry.text), PROMPT_ENTRY_RUNES)
  }`;
}
