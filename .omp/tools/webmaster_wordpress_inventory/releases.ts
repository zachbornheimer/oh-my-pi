import { describeError, type SecurityNet } from "./net.ts";

/** Where WordPress.org publishes its releases: one offer per supported branch. */
export const RELEASES_URL = "https://api.wordpress.org/core/version-check/1.7/";

export type Releases =
  | { status: "measured"; versions: string[] }
  | { status: "unmeasured"; reason: string };

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

/** WordPress.org's current releases; a failed read is `unmeasured` with why, a cancelled run throws. */
export async function readReleases(net: SecurityNet, signal?: AbortSignal): Promise<Releases> {
  try {
    const answer = await net.request("GET", RELEASES_URL, undefined, signal);
    return { status: "measured", versions: releasesFrom(answer.body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `the WordPress releases are unknown: ${describeError(error)}` };
  }
}
