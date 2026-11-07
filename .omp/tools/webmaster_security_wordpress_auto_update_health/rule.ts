import { listed, type SecurityFinding, securityFinding, type Verdict } from "./check.ts";
import { branchOf, coreStanding } from "./core_standing.ts";
import type { WordpressInspect } from "./inspect.ts";
import type { Releases } from "./public_api.ts";
import { linesOf, type MeasuredInspect, ranOutput, unreadable } from "./wp_cli.ts";

export const CHECK = "webmaster.security.wordpress.auto_update_health";

/** Filters that answer WordPress' update lookup before it asks WordPress.org: any callback on them blinds discovery. */
const BLINDING_FILTERS = ["pre_site_transient_update_core", "pre_site_transient_update_plugins"] as const;
/** Filters that decide whether core updates itself, with the one stock callback that leaves updates on. */
const STOPPING_FILTERS = { auto_update_core: "__return_true", automatic_updater_disabled: "__return_false" } as const;
/** `wp_version_check` runs twice a day; used when the event names no interval. */
const DEFAULT_VERSION_CHECK_SECONDS = 12 * 60 * 60;
/** How many intervals the version check may be late before something is stopping it. */
const OVERDUE_INTERVALS = 2;
const RELEASE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
const DISCOVERY_ROW = /^\{.*\}$/;

type Callback = { readonly callback: string; readonly file: string };

/** What the inspection's `update_discovery` command prints: the hooks that can blind or stop updates, as JSON. */
export interface UpdateDiscovery {
  readonly hooks: Readonly<Record<string, readonly Callback[]>>;
  readonly constants: { readonly AUTOMATIC_UPDATER_DISABLED?: unknown; readonly WP_AUTO_UPDATE_CORE?: unknown };
  readonly version_check: { readonly timestamp: number; readonly interval: number } | null;
  readonly now: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The discovery reading when `value` has its shape, else undefined. */
export function parseUpdateDiscovery(value: unknown): UpdateDiscovery | undefined {
  if (!isObject(value) || !isObject(value["hooks"]) || !isObject(value["constants"])) return undefined;
  const hooks: Record<string, Callback[]> = {};
  for (const [name, callbacks] of Object.entries(value["hooks"])) {
    if (!Array.isArray(callbacks)) return undefined;
    const parsed: Callback[] = [];
    for (const callback of callbacks) {
      if (!isObject(callback) || typeof callback["callback"] !== "string" || typeof callback["file"] !== "string") {
        return undefined;
      }
      parsed.push({ callback: callback["callback"], file: callback["file"] });
    }
    hooks[name] = parsed;
  }
  const event = value["version_check"];
  const versionCheck = event === null
    ? null
    : isObject(event) && typeof event["timestamp"] === "number" && typeof event["interval"] === "number"
    ? { timestamp: event["timestamp"], interval: event["interval"] }
    : undefined;
  if (versionCheck === undefined || typeof value["now"] !== "number") return undefined;
  return {
    hooks,
    constants: {
      AUTOMATIC_UPDATER_DISABLED: value["constants"]["AUTOMATIC_UPDATER_DISABLED"],
      WP_AUTO_UPDATE_CORE: value["constants"]["WP_AUTO_UPDATE_CORE"],
    },
    version_check: versionCheck,
    now: value["now"],
  };
}

/** Who hooked a callback, as far as its file says: a plugin, a must-use plugin, a theme, or only its name. */
function hookedBy({ callback, file }: Callback): string {
  const owner = /\/(mu-plugins|plugins|themes)\/([^/]+)/.exec(file);
  if (owner !== null) {
    const kind = owner[1] === "themes" ? "theme" : owner[1] === "mu-plugins" ? "must-use plugin" : "plugin";
    return `${kind} ${owner[2]} (${callback})`;
  }
  return /\/wp-(includes|admin)\//.test(file)
    ? `a WordPress helper, \`${callback}\`, which does not show which plugin hooked it`
    : callback;
}

function installedVersion(inspect: MeasuredInspect): string | { readonly unmeasured: string } {
  const output = ranOutput(inspect, "core_version");
  if ("unmeasured" in output) return output;
  const version = linesOf(output.stdout).find((line) => RELEASE_VERSION.test(line));
  return output.code === 0 && version !== undefined ? version : unreadable(output);
}

function discoveryOf(inspect: MeasuredInspect): UpdateDiscovery | { readonly unmeasured: string } {
  const output = ranOutput(inspect, "update_discovery");
  if ("unmeasured" in output) return output;
  const row = linesOf(output.stdout).find((line) => DISCOVERY_ROW.test(line));
  try {
    const parsed = parseUpdateDiscovery(JSON.parse(row ?? ""));
    if (output.code === 0 && parsed !== undefined) return parsed;
  } catch {
    // Not JSON: unreadable below.
  }
  return unreadable(output);
}

/** Core that is behind its branch, or on a branch WordPress.org no longer releases. Needs the installed version. */
function coreFindings(version: string, released: readonly string[]): SecurityFinding[] {
  const standing = coreStanding(version, released);
  if (standing.status === "fail") {
    return [securityFinding(
      "security.wordpress.auto_update_health.core_behind",
      "high",
      `WordPress ${version} is installed, behind ${standing.branchLatest}, the latest release of its ${standing.branch} `
        + `branch (newest overall ${standing.newest}), so automatic updates are not reaching it.`,
      "Have the hosting agent update core to the latest release of the branch after a backup, and find what stopped the updater.",
      "Keep automatic core updates on, and watch this check rather than `wp core check-update`, which a plugin can blind.",
    )];
  }
  if (standing.status === "warn" && !released.some((release) => branchOf(release) === standing.branch)) {
    return [securityFinding(
      "security.wordpress.auto_update_health.core_unsupported_branch",
      "high",
      `WordPress ${version} is on the ${standing.branch} branch, which WordPress.org no longer releases `
        + `(supported branches: ${released.map(branchOf).join(", ")}); it gets no security fixes.`,
      "Have the hosting agent move the site to a supported branch after a backup.",
      "Plan major upgrades before a branch reaches its end of life.",
    )];
  }
  return [];
}

/** Filters that blind update discovery or stop core updating, with who hooked each. */
function hookFindings(discovery: UpdateDiscovery): SecurityFinding[] {
  const blinding = BLINDING_FILTERS.flatMap((hook) =>
    (discovery.hooks[hook] ?? []).map((callback) => `\`${hook}\` hooked by ${hookedBy(callback)}`)
  );
  const stopping = Object.entries(STOPPING_FILTERS).flatMap(([hook, harmless]) =>
    (discovery.hooks[hook] ?? []).filter((callback) => callback.callback !== harmless).map((callback) =>
      `\`${hook}\` hooked by ${hookedBy(callback)}`
    )
  );
  return [
    ...blinding.length === 0 ? [] : [securityFinding(
      "security.wordpress.auto_update_health.update_discovery_blinded",
      "high",
      `Something answers WordPress' update lookup before WordPress.org is asked, so \`wp core check-update\` and the `
        + `dashboard can say "up to date" for a release that exists: ${listed(blinding)}.`,
      "Have the hosting agent deactivate the plugin or theme that hooks it, then update core.",
      "Never run a plugin that hides update notices on a production site.",
    )],
    ...stopping.length === 0 ? [] : [securityFinding(
      "security.wordpress.auto_update_health.auto_update_blocked",
      "high",
      `A callback on a filter that decides whether core updates itself can switch automatic updates off: `
        + `${listed(stopping)}.`,
      "Have the hosting agent read each callback and remove any that turns core updates off.",
      "Leave automatic core updates to WordPress; set them only in wp-config.php.",
    )],
  ];
}

const isSet = (value: unknown): boolean => Boolean(value) && value !== "0" && value !== "false";

/** `AUTOMATIC_UPDATER_DISABLED` or `WP_AUTO_UPDATE_CORE=false` in the site's configuration. */
function constantFindings(discovery: UpdateDiscovery): SecurityFinding[] {
  const set = [
    ...isSet(discovery.constants.AUTOMATIC_UPDATER_DISABLED) ? ["AUTOMATIC_UPDATER_DISABLED"] : [],
    ...discovery.constants.WP_AUTO_UPDATE_CORE === false ? ["WP_AUTO_UPDATE_CORE=false"] : [],
  ];
  return set.length === 0 ? [] : [securityFinding(
    "security.wordpress.auto_update_health.updater_disabled",
    "medium",
    `The site's configuration turns automatic core updates off: ${set.join(", ")}.`,
    "Have the hosting agent confirm someone owns core updates on this site before leaving it off.",
    "Remove the constant, or update core on a schedule someone checks.",
  )];
}

/** `wp_version_check` that is not scheduled, or later than two of its own intervals. */
function cronFindings(discovery: UpdateDiscovery): SecurityFinding[] {
  const event = discovery.version_check;
  const interval = event !== null && event.interval > 0 ? event.interval : DEFAULT_VERSION_CHECK_SECONDS;
  const lateBy = event === null ? 0 : discovery.now - event.timestamp;
  if (event !== null && lateBy <= OVERDUE_INTERVALS * interval) return [];
  return [securityFinding(
    "security.wordpress.auto_update_health.version_check_cron",
    "medium",
    event === null
      ? "The `wp_version_check` cron event is not scheduled, so WordPress never looks for updates."
      : `The \`wp_version_check\` cron event is ${Math.round(lateBy / 3600)} hours late (its interval is `
        + `${Math.round(interval / 3600)} hours), so WordPress is not looking for updates.`,
    "Have the hosting agent check that WP-Cron runs, or that a system cron calls it.",
    "Run `wp cron event run --due-now` from a system cron when WP-Cron is disabled.",
  )];
}

/**
 * Whether core updates reach the site: its installed version against the WordPress.org releases (never `wp core
 * check-update`, which the filters below answer for), the filters and constants that blind or stop the updater, and
 * the version-check cron. Findings stand even when another reading failed; without a finding, an unread part leaves
 * the check unmeasured, never passing.
 */
export function autoUpdateHealthVerdict(inspect: WordpressInspect | undefined, releases: Releases | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const findings: SecurityFinding[] = [];
  const unread: string[] = [];

  const version = installedVersion(inspect);
  const released = releases === undefined
    ? { unmeasured: "the WordPress releases were not read" }
    : releases.status === "measured"
    ? releases.versions
    : { unmeasured: releases.reason };
  if (typeof version !== "string") unread.push(version.unmeasured);
  else if ("unmeasured" in released) unread.push(released.unmeasured);
  else findings.push(...coreFindings(version, released));

  const discovery = discoveryOf(inspect);
  if ("unmeasured" in discovery) unread.push(discovery.unmeasured);
  else findings.push(...hookFindings(discovery), ...constantFindings(discovery), ...cronFindings(discovery));

  if (findings.length > 0) return findings;
  return unread.length > 0 ? { unmeasured: unread.join("; ") } : [];
}
