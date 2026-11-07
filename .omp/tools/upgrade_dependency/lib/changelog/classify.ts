import type { Kind } from "../schemas.js";

// Port of agentmux internal/changelog/classify.go: what a change note means to an upgrader, by keyword
// alone, so the same text always gets the same Kind. kindRules is in precedence order.

const KIND_RULES: { kind: Kind; pattern: RegExp }[] = [
  { kind: "breaking", pattern: /\bbreaking\b/i },
  { kind: "deprecation", pattern: /deprecat/i },
  { kind: "security", pattern: /\bcve-\d|security|vulnerab|advisory|\bghsa-/i },
  { kind: "behavior", pattern: /\bnow\b|\bno longer\b|\bchanged\b|\bdefaults?\b/i },
  { kind: "fix", pattern: /\bfix(?:es|ed)?\b/i },
];

/** Classify says what a change note means to an upgrader, by keyword alone. */
export function Classify(text: string): Kind {
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return "other";
}
