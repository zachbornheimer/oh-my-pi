/** Query parameters that only track a click; a plain address drops them. */
const TRACKING_PARAMETER = /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|_ga)$/i;

/**
 * The address as one page: http(s) only, no fragment, no tracking parameters, no trailing slash past the root.
 * Undefined when the text is not a web address. Two spellings of one page share a plain address.
 */
export function plainUrl(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  // Deleting while iterating the live key list would skip entries, so the loop walks a snapshot.
  for (const name of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAMETER.test(name)) url.searchParams.delete(name);
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** The host that stands for the page's publisher: lower case, without a leading `www.`. */
export function publisherHost(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return address;
  }
}
