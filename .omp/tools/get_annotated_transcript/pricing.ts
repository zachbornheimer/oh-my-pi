/** Tokens of one model call, as the loop counts them: `input` is what was not cached. */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** USD per million tokens, for each kind of token a provider bills. */
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** Bumped whenever a row below changes, so a stored estimate says which table made it. */
export const PRICING_VERSION = "2026-10-20";

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const USD_DECIMALS = 1_000_000;

/** What a model that matches no row is priced at: the mid tier, so an unknown model is neither free nor the dearest. */
export const DEFAULT_PRICE: Price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };

interface PriceRow {
  /** Matched against the model id lower-cased, without its provider prefix, with `.` written as `-`. */
  readonly model_pattern: RegExp;
  readonly price: Price;
}

/** First match wins, so a narrower pattern sits above the broader one it would also match. */
const PRICE_TABLE: readonly PriceRow[] = [
  {
    model_pattern: /opus-4(-[01])?(-\d{8})?$|claude-3-opus/,
    price: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  },
  { model_pattern: /opus/, price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
  { model_pattern: /sonnet/, price: DEFAULT_PRICE },
  { model_pattern: /haiku-3(-5)?/, price: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 } },
  { model_pattern: /haiku/, price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
  { model_pattern: /gpt-4-1-mini/, price: { input: 0.4, output: 1.6, cache_read: 0.1, cache_write: 0.4 } },
  { model_pattern: /gpt-4-1$/, price: { input: 2, output: 8, cache_read: 0.5, cache_write: 2 } },
];

/** The price of a model and whether a table row named it; a model with no row is priced at `DEFAULT_PRICE` and `known: false`. */
export function priceOf(model: string | undefined): { readonly price: Price; readonly known: boolean } {
  if (model === undefined || model === "") return { price: DEFAULT_PRICE, known: false };
  const bare = model.toLowerCase().slice(model.indexOf("/") + 1).replaceAll(".", "-");
  const row = PRICE_TABLE.find((entry) => entry.model_pattern.test(bare));
  return row === undefined ? { price: DEFAULT_PRICE, known: false } : { price: row.price, known: true };
}

/** The estimated USD of `tokens` at `model`'s price. Pure: the same tokens and model always give the same number. */
export function estimateUsd(tokens: TokenCounts, model: string | undefined): number {
  const { price } = priceOf(model);
  const usd = (tokens.input * price.input
    + tokens.output * price.output
    + tokens.cache_read * price.cache_read
    + tokens.cache_write * price.cache_write)
    / TOKENS_PER_PRICE_UNIT;
  return Math.round(usd * USD_DECIMALS) / USD_DECIMALS;
}
