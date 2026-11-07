const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "omp-webmaster-page/1.0 (+https://github.com/zysys/site-probes)";

/** What the tools accept as a page: an absolute http or https address. Throws a message naming the problem otherwise. */
export function webUrl(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(`"${address}" is not an address; give an absolute http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`"${address}" is not an http or https address`);
  }
  if (parsed.hostname === "") {
    throw new Error(`"${address}" has no host`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`"${address}" carries credentials; give a plain http or https URL`);
  }
  return parsed.toString();
}

export interface PageResponse {
  readonly status: number;
  /** The address the answer came from: the last one when redirects were followed. */
  readonly url: string;
  /** Where a 3xx points, as an absolute address. */
  readonly location?: string;
  readonly xRobotsTag: string;
  readonly contentType: string;
  readonly body: string;
  /** Milliseconds until the response headers arrived. */
  readonly ttfbMs: number;
}

export interface GetPageOptions {
  /** Follow redirects (default) or stop at the first response so the 3xx can be read. */
  readonly follow?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One GET, the boundary every page probe reads a page through. Rejects when the page cannot be reached. */
export async function getPage(url: string, options: GetPageOptions = {}): Promise<PageResponse> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const response = await fetch(new URL(webUrl(url)), {
    redirect: options.follow === false ? "manual" : "follow",
    headers: { "user-agent": USER_AGENT },
    signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
  });
  const ttfbMs = Math.round(performance.now() - started);
  const location = response.headers.get("location");
  return {
    status: response.status,
    url: response.url || url,
    ...(location === null ? {} : { location: new URL(location, url).toString() }),
    xRobotsTag: response.headers.get("x-robots-tag") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
    ttfbMs,
  };
}

export const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
