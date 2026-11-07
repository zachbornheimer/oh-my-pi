import { plainUrl } from "./page_address.ts";
import type { Pattern, SynthesisAnswer } from "./schemas.ts";

const inRange = (index: number | null, count: number): index is number => index !== null && index >= 0 && index < count;

/** A pattern row whose analog_index addresses a supplied analog on a REMOTE row only, and source sits on EXTERNAL only. */
function checkedPattern(pattern: Pattern, analogCount: number): Pattern {
  return {
    ...pattern,
    analog_index: pattern.evidence_class === "REMOTE" && inRange(pattern.analog_index, analogCount)
      ? pattern.analog_index
      : null,
    source: pattern.evidence_class === "EXTERNAL" ? pattern.source : null,
  };
}

/**
 * The synthesis answer with every index checked against the analogs supplied: a REMOTE entry that addresses no
 * analog is dropped, an analog_index outside the list or on a non-REMOTE row is cleared, a source on a non-EXTERNAL
 * row is cleared, and EXTERNAL addresses lose their tracking parameters (an address that is not one is dropped).
 */
export function validateSynthesis(answer: SynthesisAnswer, analogCount: number): SynthesisAnswer {
  const patterns = (rows: readonly Pattern[]) => rows.map((row) => checkedPattern(row, analogCount));
  return {
    ...answer,
    remote: {
      analogs: answer.remote.analogs.filter((entry) => inRange(entry.analog_index, analogCount)),
      recurring_patterns: analogCount === 0 ? [] : answer.remote.recurring_patterns,
    },
    external: answer.external.flatMap((example) => {
      const url = plainUrl(example.url);
      return url === undefined ? [] : [{ ...example, url }];
    }),
    patterns: {
      ui: patterns(answer.patterns.ui),
      ux: patterns(answer.patterns.ux),
      content: patterns(answer.patterns.content),
      seo: patterns(answer.patterns.seo),
    },
  };
}
