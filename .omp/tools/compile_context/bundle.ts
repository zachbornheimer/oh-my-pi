import type { ContextBudget, ContextItem } from "./schemas.js";
import { runeCount } from "./text.js";

const RUNES_PER_TOKEN = 4;

export const DIMENSION_ITEMS = "max_items";
export const DIMENSION_CHARS = "max_chars";
export const SIZE_DIMENSION = "max_tokens";

/** The size of `chars` runes under the bundle's basis: `ceil(chars / 4)`. */
export function estimateTokens(chars: number): number {
  return Math.floor((chars + RUNES_PER_TOKEN - 1) / RUNES_PER_TOKEN);
}

/** Retained items measured against a budget (agentmux `bundle`). */
export class Bundle {
  readonly items: ContextItem[] = [];
  chars = 0;

  constructor(readonly budget: ContextBudget) {}

  /** The first budget dimension that adding `runes` more would break, or "" when it fits. */
  exceeded(runes: number): string {
    const { max_items, max_chars, max_tokens } = this.budget;
    if (max_items > 0 && this.items.length + 1 > max_items) {
      return DIMENSION_ITEMS;
    }
    if (max_chars > 0 && this.chars + runes > max_chars) {
      return DIMENSION_CHARS;
    }
    if (max_tokens > 0 && estimateTokens(this.chars + runes) > max_tokens) {
      return SIZE_DIMENSION;
    }
    return "";
  }

  add(item: ContextItem): void {
    this.items.push(item);
    this.chars += runeCount(item.text);
  }

  overBudget(): boolean {
    const { max_items, max_chars, max_tokens } = this.budget;
    return (
      (max_items > 0 && this.items.length > max_items)
      || (max_chars > 0 && this.chars > max_chars)
      || (max_tokens > 0 && estimateTokens(this.chars) > max_tokens)
    );
  }
}
