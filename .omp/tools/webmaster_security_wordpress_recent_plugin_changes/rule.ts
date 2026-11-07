import { listed, securityFinding, type Verdict } from "./check.ts";
import type { WordpressInspect } from "./inspect.ts";
import { linesOf, scanOutput } from "./wp_cli.ts";

export const CHECK = "webmaster.security.wordpress.recent_plugin_changes";
const FILE_MANAGER = /file-?manager/i;

/** The last path segment of each folder a scan printed. */
const namesIn = (stdout: string): string[] => linesOf(stdout).map((path) => path.split("/").at(-1) ?? path);

/**
 * Plugin and theme directories changed within the inspection's recent days, in the folders WordPress names; a file
 * manager among the plugins is high. A folder that could not be scanned leaves the check unmeasured unless the other
 * folder already shows a change, and never passes.
 */
export function recentPluginChangesVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const pluginScan = scanOutput(inspect, "plugin_directories");
  const themeScan = scanOutput(inspect, "theme_directories");
  const plugins = "unmeasured" in pluginScan ? [] : namesIn(pluginScan.stdout);
  const themes = "unmeasured" in themeScan ? [] : namesIn(themeScan.stdout);
  if (plugins.length === 0 && themes.length === 0) {
    if ("unmeasured" in pluginScan) return pluginScan;
    if ("unmeasured" in themeScan) return themeScan;
    return [];
  }
  const fileManager = plugins.some((plugin) => FILE_MANAGER.test(plugin));
  const changed = [
    ...plugins.length === 0 ? [] : [`plugin directories ${listed(plugins)}`],
    ...themes.length === 0 ? [] : [`theme directories ${listed(themes)}`],
  ].join("; ");
  return [securityFinding(
    "security.wordpress.recent_plugin_changes",
    fileManager ? "high" : "low",
    `Changed in the last ${inspect.recent_days} days: ${changed}.`
      + ("unmeasured" in pluginScan ? ` Plugins were not scanned: ${pluginScan.unmeasured}.` : "")
      + ("unmeasured" in themeScan ? ` Themes were not scanned: ${themeScan.unmeasured}.` : "")
      + (fileManager ? " A file manager plugin gives whoever reaches it full write access to the site." : ""),
    fileManager
      ? "Have the hosting agent take the file manager plugin offline now and check what it changed."
      : "Match each change to an update the site's owner made.",
    "Make plugin and theme changes only through recorded updates.",
  )];
}
