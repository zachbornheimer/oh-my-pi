import { listed, securityFinding, type Verdict } from "./check.ts";
import type { WordpressInspect } from "./inspect.ts";
import { linesOf, scanOutput } from "./wp_cli.ts";

export const CHECK = "webmaster.security.wordpress.uploads_php";

/** PHP files under the uploads folder WordPress names (not always `wp-content/uploads`). */
export function uploadsPhpVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = scanOutput(inspect, "uploads_php");
  if ("unmeasured" in output) return output;
  const files = linesOf(output.stdout);
  if (files.length === 0) return [];
  return [securityFinding(
    "security.wordpress.uploads_php",
    "high",
    `PHP files sit in the uploads folder, where only media belongs: ${listed(files)}.`,
    "Have the hosting agent move these files out of the web root and find how they got there.",
    "Deny PHP execution under the uploads folder at the web server.",
  )];
}
