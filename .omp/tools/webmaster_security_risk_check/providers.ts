/** One search hit. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** How long one provider's request may take before it is abandoned. */
export const SEARCH_TIMEOUT_MS = 15_000;

/** The providers that can answer, in preference order. */
export type ProviderName = "openrouter" | "duckduckgo";

/**
 * The providers to try, in order: OpenRouter's web plugin when its key is in the environment,
 * then DuckDuckGo's keyless lite endpoint, which needs no credential at all.
 */
export function resolveProviders(env: NodeJS.ProcessEnv & Partial<Record<"OPENROUTER_API_KEY", string>> = process.env): ProviderName[] {
  const providers: ProviderName[] = [];
  if (env.OPENROUTER_API_KEY !== undefined && env.OPENROUTER_API_KEY !== "") providers.push("openrouter");
  providers.push("duckduckgo");
  return providers;
}

/** Ask one provider, parse its reply, and return at most `limit` results. Throws on any failure. */
export async function searchWith(
  provider: ProviderName,
  query: string,
  limit: number,
  timeoutMs: number = SEARCH_TIMEOUT_MS,
): Promise<WebSearchResult[]> {
  switch (provider) {
    case "openrouter":
      return openrouterSearch(query, limit, timeoutMs);
    case "duckduckgo":
      return duckduckgoSearch(query, limit, timeoutMs);
  }
}

// OpenRouter: the search integration this repo already runs (src/mastra/web-tools.ts), its web plugin
// over the chat completions API. The key is read from the environment at call time, never hardcoded.

interface OpenRouterReply {
  readonly choices?: readonly {
    readonly message?: {
      readonly annotations?: readonly { readonly url_citation?: { readonly url?: string; readonly title?: string } }[];
    };
  }[];
}

async function openrouterSearch(query: string, limit: number, timeoutMs: number): Promise<WebSearchResult[]> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [{ role: "user", content: query }],
      plugins: [{ id: "web", max_results: limit }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const reply = JSON.parse(text) as OpenRouterReply;
  const annotations = reply.choices?.[0]?.message?.annotations ?? [];
  const results = annotations.flatMap((note): WebSearchResult[] => {
    const url = note.url_citation?.url;
    if (url === undefined || url === "") return [];
    return [{ title: note.url_citation?.title ?? "", url, snippet: "" }];
  });
  return results.slice(0, limit);
}

// DuckDuckGo: the keyless default. The lite endpoint is a plain HTML table, parsed with the two
// row classes it has had for years (`result-link`, `result-snippet`); its links are redirects that
// carry the real target in their `uddg` parameter.

const USER_AGENT = "Mozilla/5.0 (compatible; capability-runtime web_search)";

async function duckduckgoSearch(query: string, limit: number, timeoutMs: number): Promise<WebSearchResult[]> {
  const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${html.slice(0, 200)}`);
  return parseDuckDuckGoLite(html, limit);
}

/** The results of a lite endpoint page, in its order, without the redirect wrapper. */
export function parseDuckDuckGoLite(html: string, limit: number): WebSearchResult[] {
  const links: { title: string; url: string }[] = [];
  for (const [, attributes, body] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/class\s*=\s*["'][^"']*result-link/i.test(attributes)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (href === undefined) continue;
    const url = redirectTarget(href);
    if (url === "") continue;
    links.push({ title: decodeText(body), url });
  }
  const snippets = [...html.matchAll(/<td[^>]*class\s*=\s*["'][^"']*result-snippet[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(([, body]) => decodeText(body));
  return links.slice(0, limit).map((link, index) => ({ ...link, snippet: snippets[index] ?? "" }));
}

/** The page a lite-endpoint link really points at: the `uddg` parameter of its redirect, or its own
 * http(s) URL when it is not one of DuckDuckGo's redirect wrappers. Anything else is dropped. */
function redirectTarget(href: string): string {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  if (absolute.includes("uddg=")) {
    try {
      return new URL(absolute).searchParams.get("uddg") ?? "";
    } catch {
      return "";
    }
  }
  if (/^https?:\/\//i.test(absolute) && !/duckduckgo\.com\/l\//i.test(absolute)) return absolute;
  return "";
}

/** Readable text of an HTML fragment: tags dropped, the HTML entities decoded, whitespace collapsed. */
function decodeText(fragment: string): string {
  const decoded = fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity: string, body: string) => decodeEntity(entity, body));
  return decoded.replace(/\s+/g, " ").trim();
}

/** One entity by body: `#65` and `#x41` are numbers, anything else a name from the table. */
function decodeEntity(entity: string, body: string): string {
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    const scalar = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return scalar ? String.fromCodePoint(code) : entity;
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

const AMPERSAND = String.fromCodePoint(0x26); // &
const APOSTROPHE = String.fromCodePoint(0x27); // '
const GREATER_THAN = String.fromCodePoint(0x3e); // >
const LESS_THAN = String.fromCodePoint(0x3c); // <
const QUOTE = String.fromCodePoint(0x22); // "
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: AMPERSAND,
  apos: APOSTROPHE,
  gt: GREATER_THAN,
  lt: LESS_THAN,
  nbsp: " ",
  quot: QUOTE,
};
