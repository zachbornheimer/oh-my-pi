import { listed, securityFinding, type Verdict } from "./check.ts";
import type { WordpressInspect } from "./inspect.ts";
import { field, jsonRows, ranOutput, unreadable } from "./wp_cli.ts";

export const CHECK = "webmaster.security.wordpress.plugin_integrity";

/**
 * Plugin files `wp plugin verify-checksums --all --format=json` reports as differing. WP-CLI exits 1 when files differ
 * (still printing them), so a differing file stands whatever the exit code; no rows with a non-zero exit is a command
 * that failed (not a WordPress install, an error), never a pass.
 */
export function pluginIntegrityVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "plugin_checksums");
  if ("unmeasured" in output) return output;
  const rows = jsonRows(output.stdout);
  if (rows === undefined) return unreadable(output);
  const files = rows.map((row) => `${field(row, "plugin_name")}: ${field(row, "file")} (${field(row, "message")})`);
  if (files.length === 0) return output.code === 0 ? [] : unreadable(output);
  return [securityFinding(
    "security.wordpress.plugin_integrity",
    "high",
    `${files.length} plugin file(s) differ from the wordpress.org release: ${listed(files)}.`,
    "Hand the site to the hosting agent: a changed plugin file can be a backdoor. Take the plugin offline until it "
      + "is reinstalled from wordpress.org.",
    "Reinstall changed plugins from their releases and remove any plugin no longer in use.",
  )];
}
