/** How long one provider's request may take before it is abandoned. */
export const SEARCH_TIMEOUT_MS = 15_000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ProviderName = "openrouter" | "duckduckgo";

export type SearchFetch = (url: string, init: RequestInit) => Promise<Response>;

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DUCKDUCKGO_QUERY_PREFIX = "https://lite.duckduckgo.com/lite/?q=";

/** The real fetch: it reaches the two search providers' endpoints and nothing else; any other address throws. */
function searchProviderFetch(url: string, init: RequestInit): Promise<Response> {
  if (url === OPENROUTER_ENDPOINT) return fetch("https://openrouter.ai/api/v1/chat/completions", init);
  if (url.startsWith(DUCKDUCKGO_QUERY_PREFIX)) {
    return fetch(`https://lite.duckduckgo.com/lite/?q=${url.slice(DUCKDUCKGO_QUERY_PREFIX.length)}`, init);
  }
  throw new Error("web search only fetches its two providers' endpoints");
}

export type WebSearch = (
  query: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<{ readonly provider: ProviderName; readonly results: WebSearchResult[] }>;

const withTimeout = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

/**
 * The providers to try, in order: OpenRouter's web plugin when its key is in the environment, then DuckDuckGo's
 * keyless lite endpoint, which needs no credential at all.
 */
export function resolveProviders(env: Readonly<Record<string, string | undefined>> = process.env): ProviderName[] {
  const key = env["OPENROUTER_API_KEY"];
  return key !== undefined && key !== "" ? ["openrouter", "duckduckgo"] : ["duckduckgo"];
}

interface OpenRouterReply {
  readonly choices?: readonly {
    readonly message?: {
      readonly annotations?: readonly { readonly url_citation?: { readonly url?: string; readonly title?: string } }[];
    };
  }[];
}

async function openrouterSearch(
  fetcher: SearchFetch,
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [{ role: "user", content: query }],
      plugins: [{ id: "web", max_results: limit }],
    }),
    signal: withTimeout(signal),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200).replaceAll(apiKey, "<key>")}`);
  const reply = JSON.parse(text) as OpenRouterReply;
  const annotations = reply.choices?.[0]?.message?.annotations ?? [];
  const results = annotations.flatMap((note): WebSearchResult[] => {
    const url = note.url_citation?.url;
    if (url === undefined || url === "") return [];
    return [{ title: note.url_citation?.title ?? "", url, snippet: "" }];
  });
  return results.slice(0, limit);
}

const USER_AGENT = "Mozilla/5.0 (compatible; omp-webmaster-page web search)";

async function duckduckgoSearch(
  fetcher: SearchFetch,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const response = await fetcher(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: withTimeout(signal),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${html.slice(0, 200)}`);
  return parseDuckDuckGoLite(html, limit);
}

/** The results of a lite endpoint page, in its order, without the redirect wrapper. */
export function parseDuckDuckGoLite(html: string, limit: number): WebSearchResult[] {
  const links: { title: string; url: string }[] = [];
  for (const [, attributes, body] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/class\s*=\s*["'][^"']*result-link/i.test(attributes ?? "")) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attributes ?? "")?.[1];
    if (href === undefined) continue;
    const url = redirectTarget(href);
    if (url === "") continue;
    links.push({ title: decodeText(body ?? ""), url });
  }
  const snippets = [...html.matchAll(/<td[^>]*class\s*=\s*["'][^"']*result-snippet[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(([, body]) => decodeText(body ?? ""));
  return links.slice(0, limit).map((link, index) => ({ ...link, snippet: snippets[index] ?? "" }));
}

/**
 * The page a lite-endpoint link really points at: the `uddg` parameter of its redirect, or its own http(s) URL when it
 * is not one of DuckDuckGo's redirect wrappers. Anything else is dropped.
 */
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

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

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

/**
 * The real search: OpenRouter's web plugin when `OPENROUTER_API_KEY` is set, else DuckDuckGo's lite endpoint; a failed
 * provider falls through to the next. Throws with the last provider's reason when every provider fails.
 */
export function systemWebSearch(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: SearchFetch = searchProviderFetch,
): WebSearch {
  return async (query, limit, signal) => {
    const providers = resolveProviders(env);
    let lastProvider: ProviderName = providers[providers.length - 1] ?? "duckduckgo";
    let lastError = "no provider available";
    for (const provider of providers) {
      try {
        const results = provider === "openrouter"
          ? await openrouterSearch(fetcher, env["OPENROUTER_API_KEY"] ?? "", query, limit, signal)
          : await duckduckgoSearch(fetcher, query, limit, signal);
        return { provider, results };
      } catch (error) {
        signal?.throwIfAborted();
        lastProvider = provider;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`web search failed on ${lastProvider}: ${lastError}`);
  };
}
