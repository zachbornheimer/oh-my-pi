import { ask, describeError, type HttpAnswer, recorded, type SecurityNet } from "./net.ts";

/**
 * What a WordPress site's public endpoints answer an anonymous visitor, plus WordPress.org's current releases, asked
 * for one part at a time: a check sends only the requests it reads. GET, except one POST of the empty batch
 * `{"requests":[]}` to each batch route. Collects only. Port of Mastra's `security/wordpress_public_api.ts`.
 */

/** The only body ever POSTed: an empty batch, which WordPress answers without running anything. */
export const REST_BATCH_BODY = JSON.stringify({ requests: [] });

/** Where WordPress.org publishes its releases: one offer per supported branch. */
export const RELEASES_URL = "https://api.wordpress.org/core/version-check/1.7/";

export type Releases =
  | { status: "measured"; versions: string[] }
  | { status: "unmeasured"; reason: string };

export type PublicApiPart = "home" | "feed" | "readme" | "rest_batch" | "xmlrpc" | "users" | "author" | "releases";

/** Only the parts that were asked for are present. */
export interface PublicApiReading {
  /** `GET /`, one redirect within the site followed. */
  home?: HttpAnswer;
  /** `GET /feed/`, one redirect within the site followed. */
  feed?: HttpAnswer;
  /** `GET /readme.html`. */
  readme?: HttpAnswer;
  /** An anonymous empty batch POSTed to `/?rest_route=/batch/v1` and `/wp-json/batch/v1`. */
  rest_batch?: HttpAnswer[];
  /** `GET /xmlrpc.php`. */
  xmlrpc?: HttpAnswer;
  /** `GET /wp-json/wp/v2/users` and `/?rest_route=/wp/v2/users`. */
  users?: HttpAnswer[];
  /** `GET /?author=1`, not followed. */
  author?: HttpAnswer;
  releases?: Releases;
}

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

/** WordPress.org's release list; a failed or malformed answer is `unmeasured` with why. A cancelled run throws. */
export async function readReleases(net: SecurityNet, signal?: AbortSignal): Promise<Releases> {
  try {
    signal?.throwIfAborted();
    const answer = await net.request("GET", RELEASES_URL, undefined, signal);
    return { status: "measured", versions: releasesFrom(answer.body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `the WordPress releases are unknown: ${describeError(error)}` };
  }
}

/** Asks for the named parts at once; a request that got no answer is status 0 with the error. A cancelled run throws. */
export async function readPublicApi(
  siteUrl: string,
  parts: readonly PublicApiPart[],
  net: SecurityNet,
  signal?: AbortSignal,
): Promise<PublicApiReading> {
  const get = (path: string, follow = false) =>
    ask(net, siteUrl, { method: "GET", path, follow }, undefined, signal).then(recorded);
  const batch = (path: string) =>
    ask(net, siteUrl, { method: "POST", path, body: REST_BATCH_BODY }, undefined, signal).then(recorded);
  const want = new Set(parts);
  const [home, feed, readme, restQuery, restPath, xmlrpc, usersPath, usersQuery, author, releases] = await Promise.all([
    want.has("home") ? get("/", true) : undefined,
    want.has("feed") ? get("/feed/", true) : undefined,
    want.has("readme") ? get("/readme.html") : undefined,
    want.has("rest_batch") ? batch("/?rest_route=/batch/v1") : undefined,
    want.has("rest_batch") ? batch("/wp-json/batch/v1") : undefined,
    want.has("xmlrpc") ? get("/xmlrpc.php") : undefined,
    want.has("users") ? get("/wp-json/wp/v2/users") : undefined,
    want.has("users") ? get("/?rest_route=/wp/v2/users") : undefined,
    want.has("author") ? get("/?author=1") : undefined,
    want.has("releases") ? readReleases(net, signal) : undefined,
  ]);
  return {
    ...(home === undefined ? {} : { home }),
    ...(feed === undefined ? {} : { feed }),
    ...(readme === undefined ? {} : { readme }),
    ...(restQuery === undefined || restPath === undefined ? {} : { rest_batch: [restQuery, restPath] }),
    ...(xmlrpc === undefined ? {} : { xmlrpc }),
    ...(usersPath === undefined || usersQuery === undefined ? {} : { users: [usersPath, usersQuery] }),
    ...(author === undefined ? {} : { author }),
    ...(releases === undefined ? {} : { releases }),
  };
}
