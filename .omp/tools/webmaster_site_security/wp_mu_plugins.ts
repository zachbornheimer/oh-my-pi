import { listed, securityFinding, type Verdict } from "./check";
import { field, jsonRows, ranOutput, unreadable } from "./wp_cli";
import { type WordpressInspect } from "./inspect";

export const CHECK = "webmaster.security.wordpress.mu_plugins";

/** Drop-ins and must-use plugins well-known hosts and cache plugins install; a site file adds its own. */
export const KNOWN_MU_PLUGINS = [
  "0-worker",
  "wpengine-common",
  "slt-force-strong-passwords",
  "wpe-wp-sign-on-plugin",
  "wpe-update-source-selector",
  "health-check-troubleshooting-mode",
  "advanced-cache.php",
  "object-cache.php",
  "maintenance.php",
  "fatal-error-handler.php",
  "sunrise.php",
] as const;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** The names that match any of the globs (`*`, `?`), without case. */
export function debugFiles(names: readonly string[], patterns: readonly string[]): string[] {
  const matchers = patterns.map(globToRegExp);
  return names.filter((name) => matchers.some((matcher) => matcher.test(name)));
}

/** Must-use plugins and drop-ins nobody vouched for, and any that matches a debug-file glob. */
export interface MuPluginSettings {
  readonly known_mu_plugins?: readonly string[] | undefined;
  readonly debug_file_patterns?: readonly string[] | undefined;
}

export function muPluginsVerdict(inspect: WordpressInspect | undefined, settings: MuPluginSettings = {}): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "must_use_plugins");
  if ("unmeasured" in output) return output;
  const rows = jsonRows(output.stdout);
  if (rows === undefined || output.code !== 0) return unreadable(output);
  const early = rows.filter((row) => ["must-use", "dropin"].includes(field(row, "status")));
  const vouched = new Set<string>([...KNOWN_MU_PLUGINS, ...settings.known_mu_plugins ?? []]);
  const unknown = early.filter((row) => !vouched.has(field(row, "name"))).map((row) =>
    `${field(row, "name")} (${field(row, "status")})`
  );
  const debug = debugFiles(early.map((row) => field(row, "name")), settings.debug_file_patterns ?? []);
  return [
    ...unknown.length === 0 ? [] : [securityFinding(
      "security.wordpress.mu_plugins.unknown",
      "high",
      `Must-use plugins or drop-ins nobody vouched for are loaded on every request: ${listed(unknown)}.`,
      "Have the hosting agent read each file; move any it cannot account for out of wp-content.",
      "List the site's own must-use plugins in its site file (`security.known_mu_plugins`).",
    )],
    ...debug.length === 0 ? [] : [securityFinding(
      "security.wordpress.mu_plugins.debug_file",
      "high",
      `Debug files are loaded as must-use plugins: ${listed(debug)}.`,
      "Have the hosting agent move each debug file out of wp-content/mu-plugins.",
      "Never deploy debug helpers as must-use plugins.",
    )],
  ];
}
