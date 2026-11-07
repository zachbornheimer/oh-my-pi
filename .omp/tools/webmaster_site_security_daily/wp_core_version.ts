import { securityFinding, type Verdict } from "./check";
import { succeeded } from "./net";
import { type MeasuredPublicApi, type WordpressPublicApi } from "./public_api";

export const CHECK = "webmaster.security.wordpress.core_version";
export const VERSION_HIDDEN_REASON =
  "the site does not publish its WordPress version (generator, feed and readme hide it)";

const GENERATOR_META =
  /<meta[^>]+(?:name=["']generator["'][^>]+content=["']WordPress\s+([0-9.]+)|content=["']WordPress\s+([0-9.]+)["'][^>]+name=["']generator["'])/i;
const FEED_GENERATOR = /<generator>[^<]*wordpress\.org\/?\?v=([0-9.]+)/i;
const README_VERSION_RUN = /Version\s+(\d[\d.]*)/gi;

/** The first `Version` in a readme followed by dotted numbers (`6.4.1`): digit groups joined by single dots, at least two. */
export function readmeVersion(readme: string): string | undefined {
  for (const match of readme.matchAll(README_VERSION_RUN)) {
    const groups: string[] = [];
    for (const group of (match[1] ?? "").split(".")) {
      if (group === "") break;
      groups.push(group);
    }
    if (groups.length >= 2) return groups.join(".");
  }
  return undefined;
}
/** The version the site publishes: its generator tag, its feed's generator, or its readme. */
export function publishedVersion(api: MeasuredPublicApi): string | undefined {
  const body = (answer: MeasuredPublicApi["home"]) => (succeeded(answer) ? answer.body : "");
  const meta = GENERATOR_META.exec(body(api.home));
  return meta?.[1] ?? meta?.[2] ?? FEED_GENERATOR.exec(body(api.feed))?.[1]
    ?? readmeVersion(body(api.readme));
}

export interface CoreStanding {
  readonly installed: string;
  readonly branch: string;
  readonly branchLatest: string;
  readonly newest: string;
  /** fail: missing its own branch's security fixes. warn: current on an older branch. */
  readonly status: "pass" | "warn" | "fail";
}

/** `6.4` for `6.4.1`. */
export const branchOf = (version: string): string => version.split(".").slice(0, 2).join(".");

/** Whether version `a` is newer than `b`, part by part. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const newestOf = (versions: readonly string[], floor: string): string =>
  versions.reduce((best, version) => (isNewer(version, best) ? version : best), floor);

/** Where an installed version stands against the released ones. */
export function coreStanding(installed: string, released: readonly string[]): CoreStanding {
  const branch = branchOf(installed);
  const branchLatest = newestOf(released.filter((version) => branchOf(version) === branch), installed);
  const newest = newestOf(released, installed);
  const status = isNewer(branchLatest, installed) ? "fail" : isNewer(newest, installed) ? "warn" : "pass";
  return { installed, branch, branchLatest, newest, status };
}

/** The published version, when it is behind its branch (high) or on an older branch (medium). */
export function coreVersionVerdict(api: WordpressPublicApi | undefined): Verdict {
  if (api?.status !== "measured") return { unmeasured: api?.reason ?? "the public API was not read" };
  if (api.releases.status !== "measured") return { unmeasured: api.releases.reason };
  const version = publishedVersion(api);
  if (version === undefined) return { unmeasured: VERSION_HIDDEN_REASON };
  const standing = coreStanding(version, api.releases.versions);
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
