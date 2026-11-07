import { securityFinding, type Verdict } from "./check.ts";
import { coreStanding } from "./core_standing.ts";
import { succeeded } from "./net.ts";
import type { PublicApiReading } from "./public_api.ts";

export const CHECK = "webmaster.security.wordpress.core_version";
export const VERSION_HIDDEN_REASON =
  "the site does not publish its WordPress version (generator, feed and readme hide it)";

const GENERATOR_META =
  /<meta[^>]+(?:name=["']generator["'][^>]+content=["']WordPress\s+([0-9.]+)|content=["']WordPress\s+([0-9.]+)["'][^>]+name=["']generator["'])/i;
const FEED_GENERATOR = /<generator>[^<]*wordpress\.org\/?\?v=([0-9.]+)/i;
const README_VERSION_RUN = /Version\s+(\d[\d.]*)/gi;

/**
 * The first dotted version (`6.5`, `6.5.2`) a readme names after the word "Version". A run of digits and dots is read
 * flat, then cut at its first empty part, so `6.5.` reads `6.5` and `6..5` reads nothing; a run that does not hold a
 * dot is skipped and the next "Version" is tried.
 */
export function readmeVersion(readme: string): string | undefined {
  for (const run of readme.matchAll(README_VERSION_RUN)) {
    const parts: string[] = [];
    for (const part of run[1]!.split(".")) {
      if (part === "") break;
      parts.push(part);
    }
    if (parts.length >= 2) return parts.join(".");
  }
  return undefined;
}

/** What this check reads: the home page, the feed, the readme and the WordPress.org release list. */
export type CoreVersionReading = Pick<PublicApiReading, "home" | "feed" | "readme" | "releases">;

/** The version the site publishes: its generator tag, its feed's generator, or its readme. */
export function publishedVersion(reading: CoreVersionReading): string | undefined {
  const body = (answer: CoreVersionReading["home"]) => (answer !== undefined && succeeded(answer) ? answer.body : "");
  const meta = GENERATOR_META.exec(body(reading.home));
  return meta?.[1] ?? meta?.[2] ?? FEED_GENERATOR.exec(body(reading.feed))?.[1]
    ?? readmeVersion(body(reading.readme));
}

/** The published version, when it is behind its branch (high) or on an older branch (medium). */
export function coreVersionVerdict(reading: CoreVersionReading): Verdict {
  const { home, releases } = reading;
  if (home === undefined || releases === undefined) return { unmeasured: "the public API was not read" };
  if (home.status === 0) return { unmeasured: `${home.path} did not answer: ${home.error ?? ""}` };
  if (releases.status !== "measured") return { unmeasured: releases.reason };
  const version = publishedVersion(reading);
  if (version === undefined) return { unmeasured: VERSION_HIDDEN_REASON };
  const standing = coreStanding(version, releases.versions);
  if (standing.status === "pass") return [];
  return standing.status === "fail"
    ? [securityFinding(
      "security.wordpress.core_version.behind_branch",
      "high",
      `The site runs WordPress ${version}, behind ${standing.branchLatest}, the latest on its ${standing.branch} branch `
        + `(newest overall ${standing.newest}). It misses the security fixes that branch shipped.`,
      "Have the hosting agent apply the latest release of the same branch after a backup.",
      "Turn on automatic minor (security) releases.",
    )]
    : [securityFinding(
      "security.wordpress.core_version.older_branch",
      "medium",
      `The site runs WordPress ${version}, the latest on its ${standing.branch} branch; the newest is ${standing.newest}.`,
      "Plan the upgrade to the newest branch; only it is fully supported.",
      "Keep major upgrades on a schedule.",
    )];
}
