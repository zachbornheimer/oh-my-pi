import { listed, securityFinding, type Verdict } from "./check";
import { field, jsonRows, ranOutput, unreadable } from "./wp_cli";
import { type WordpressInspect } from "./inspect";

export const CHECK = "webmaster.security.wordpress.new_admins";
const DAY_MS = 86_400_000;

/** Whole days from `then` to `now`. */
export const daysSince = (then: Date, now: Date): number => Math.floor((now.getTime() - then.getTime()) / DAY_MS);

/** Administrators registered within the inspection's recent days. */
export function newAdminsVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "administrators");
  if ("unmeasured" in output) return output;
  const rows = jsonRows(output.stdout);
  if (rows === undefined || output.code !== 0) return unreadable(output);
  const now = new Date(inspect.measured_at);
  const recent = rows.filter((row) => {
    const registered = new Date(`${field(row, "user_registered").replace(" ", "T")}Z`);
    return !Number.isNaN(registered.getTime()) && daysSince(registered, now) < inspect.recent_days;
  }).map((row) => `${field(row, "user_login")} (registered ${field(row, "user_registered")})`);
  if (recent.length === 0) return [];
  return [securityFinding(
    "security.wordpress.new_admins",
    "high",
    `${recent.length} administrator account(s) were created in the last ${inspect.recent_days} days: ${
      listed(recent)
    }.`,
    "Confirm each account with the site owner; have the hosting agent lock any nobody recognises and end its "
      + "sessions.",
    "Create administrators only through a recorded change, and review the administrator list after any incident.",
  )];
}
