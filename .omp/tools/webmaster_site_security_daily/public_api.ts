import { ask, describeError, type HttpAnswer, type SecurityNet, recorded } from "./net.ts";

/**
 * What a WordPress site's public endpoints answer an anonymous visitor, plus the current WordPress releases. GET, except
 * one POST of the empty batch `{"requests":[]}` to each batch route. Collects only. Port of Mastra's
 * `webmaster.wordpress.public_api` schemas and `security/wordpress_public_api.ts`.
 */

/** The only body the tool ever POSTs: an empty batch, which WordPress answers without running anything. */
export const REST_BATCH_BODY = JSON.stringify({ requests: [] });

/** Where WordPress.org publishes its releases: one offer per supported branch. */
export const RELEASES_URL = "https://api.wordpress.org/core/version-check/1.7/";

export type Releases =
  | { status: "measured"; versions: string[] }
  | { status: "unmeasured"; reason: string };

export type WordpressPublicApi =
  | {
      status: "measured";
      /** `GET /`, one redirect within the site followed. */
      home: HttpAnswer;
      /** `GET /feed/`, one redirect within the site followed. */
      feed: HttpAnswer;
      /** `GET /readme.html`. */
      readme: HttpAnswer;
      /** An anonymous empty batch POSTed to `/?rest_route=/batch/v1` and `/wp-json/batch/v1`. */
      rest_batch: HttpAnswer[];
      /** `GET /xmlrpc.php`. */
      xmlrpc: HttpAnswer;
      /** `GET /wp-json/wp/v2/users` and `/?rest_route=/wp/v2/users`. */
      users: HttpAnswer[];
      /** `GET /?author=1`, not followed. */
      author: HttpAnswer;
      releases: Releases;
    }
  | { status: "unmeasured"; reason: string };

export type MeasuredPublicApi = Extract<WordpressPublicApi, { status: "measured" }>;

/** Newer versions first, part by part. */
const newestFirst = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const diff = (pb[index] ?? 0) - (pa[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * The newest release of every supported branch in a WordPress.org `version-check/1.7` answer: each offer's `current`,
 * once, newest first. Throws when the answer is not that shape.
 */
export function releasesFrom(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const offers = typeof parsed === "object" && parsed !== null && "offers" in parsed ? parsed.offers : undefined;
  if (!Array.isArray(offers)) throw new Error("the release answer has no offers");
  const versions = offers.flatMap((offer: unknown) =>
    typeof offer === "object" && offer !== null && "current" in offer && typeof offer.current === "string"
      ? [offer.current]
      : [],
  );
  return [...new Set(versions)].sort(newestFirst);
}

async function releases(net: SecurityNet, signal?: AbortSignal): Promise<Releases> {
  try {
    const answer = await net.request("GET", RELEASES_URL, undefined, signal);
    return { status: "measured", versions: releasesFrom(answer.body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `the WordPress releases are unknown: ${describeError(error)}` };
  }
}

/** Unmeasured only when the home page does not answer. A cancelled run throws. */
export async function measureWordpressPublicApi(
  target: { readonly siteUrl: string },
  net: SecurityNet,
  signal?: AbortSignal,
): Promise<WordpressPublicApi> {
  const site = target.siteUrl;
  const get = (path: string, follow = false) => ask(net, site, { method: "GET", path, follow }, undefined, signal).then(recorded);
  const batch = (path: string) => ask(net, site, { method: "POST", path, body: REST_BATCH_BODY }, undefined, signal).then(recorded);
  const home = await get("/", true);
  if (home.status === 0) {
    return { status: "unmeasured", reason: `${new URL("/", site).toString()} did not answer: ${home.error ?? ""}` };
  }
  const [feed, readme, restQuery, restPath, xmlrpc, usersPath, usersQuery, author, released] = await Promise.all([
    get("/feed/", true),
    get("/readme.html"),
    batch("/?rest_route=/batch/v1"),
    batch("/wp-json/batch/v1"),
    get("/xmlrpc.php"),
    get("/wp-json/wp/v2/users"),
    get("/?rest_route=/wp/v2/users"),
    get("/?author=1"),
    releases(net, signal),
  ]);
  return {
    status: "measured",
    home,
    feed,
    readme,
    rest_batch: [restQuery, restPath],
    xmlrpc,
    users: [usersPath, usersQuery],
    author,
    releases: released,
  };
}
