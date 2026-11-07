import { listed, securityFinding, type Verdict } from "./check";
import { field, jsonRows, ranOutput, unreadable } from "./wp_cli";
import { type WordpressInspect } from "./inspect";

export const CHECK = "webmaster.security.wordpress.plugin_integrity";

/** Plugin files `wp plugin verify-checksums --all --format=json` reports as differing. */
export function pluginIntegrityVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "plugin_checksums");
  if ("unmeasured" in output) return output;
  const rows = jsonRows(output.stdout);
  if (rows === undefined) return unreadable(output);
  const files = rows.map((row) => `${field(row, "plugin_name")}: ${field(row, "file")} (${field(row, "message")})`);
  if (files.length === 0) return [];
  return [securityFinding(
    "security.wordpress.plugin_integrity",
    "high",
    `${files.length} plugin file(s) differ from the wordpress.org release: ${listed(files)}.`,
    "Hand the site to the hosting agent: a changed plugin file can be a backdoor. Take the plugin offline until it "
      + "is reinstalled from wordpress.org.",
    "Reinstall changed plugins from their releases and remove any plugin no longer in use.",
  )];
}
