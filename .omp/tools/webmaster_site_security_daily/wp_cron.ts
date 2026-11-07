import { listed, securityFinding, type Verdict } from "./check";
import { field, jsonRows, ranOutput, unreadable } from "./wp_cli";
import { type WordpressInspect } from "./inspect";

export const CHECK = "webmaster.security.wordpress.cron";
/** A hook that looks generated rather than named by a plugin, or names what it does to the server. */
const GENERATED_HOOK = /^[a-f0-9]{12,}$|^[A-Za-z0-9]{24,}$|eval|base64|shell|exec|cmd|backdoor/i;

/** Cron hooks with generated-looking or telling names. */
export function cronVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "cron_events");
  if ("unmeasured" in output) return output;
  const rows = jsonRows(output.stdout);
  if (rows === undefined || output.code !== 0) return unreadable(output);
  const hooks = [...new Set(rows.map((row) => field(row, "hook")).filter((hook) => GENERATED_HOOK.test(hook)))];
  if (hooks.length === 0) return [];
  return [securityFinding(
    "security.wordpress.cron",
    "medium",
    `Cron events with generated-looking or telling names are scheduled: ${listed(hooks)}.`,
    "Have the hosting agent find what each hook runs before it fires again.",
    "Remove cron events whose callback belongs to no installed plugin.",
  )];
}
