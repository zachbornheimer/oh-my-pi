/** Parses an exact GitHub PR URL, rejecting look-alike hosts and ambiguous suffixes. */
export function parsePullRequestUrl(input: string): { owner: string; repo: string; number: number } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Expected a GitHub pull-request URL");
  }

  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" || url.hostname !== "github.com"
    || url.username || url.password || url.search || url.hash || !match
  ) {
    throw new Error("Expected https://github.com/OWNER/REPO/pull/NUMBER");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) throw new Error("Pull-request number is too large");
  return { owner: match[1]!, repo: match[2]!, number };
}
