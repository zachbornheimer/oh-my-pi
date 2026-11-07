import type { GroupRunResult, MemberResult } from "./loop.js";

/** The longest a member's failure text runs in the report; atask's attempt log has the rest. */
const ERROR_CHARS = 300;

const clipped = (text: string): string => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_CHARS ? `${oneLine.slice(0, ERROR_CHARS)}...` : oneLine;
};

function memberLine(member: MemberResult): string {
  const what = (() => {
    switch (member.state) {
      case "merged":
        return "merged";
      case "pull_request":
        return `pull request opened${member.url === undefined ? "" : ` ${member.url}`}`;
      case "left":
        return "complete, left in its worktree";
      case "landing_failed":
        return `verified, landing failed: ${clipped(member.error ?? "unknown")}`;
      case "complete":
        return "complete, not landed";
      case "gate_failed":
        return `gate failed: ${clipped(member.error ?? "unknown")}`;
    }
  })();
  return `- ${member.id} ${member.title}: ${what}`;
}

/**
 * The one final report of a run: a subject that says how the group ended, and a body with one
 * line per member plus atask's stall reasons or the failure.
 */
export function renderReport(result: GroupRunResult): { subject: string; body: string } {
  const lines = result.members.map(memberLine);
  const count = (...states: MemberResult["state"][]): number =>
    result.members.filter((member) => states.includes(member.state)).length;
  if (result.status === "settled") {
    const failedLandings = count("landing_failed");
    const landed = count("merged", "pull_request", "left");
    return {
      subject: `group ${result.group} settled: ${landed} of ${result.members.length} members landed`
        + (failedLandings === 0 ? "" : `, ${failedLandings} landing failed`),
      body: lines.join("\n"),
    };
  }
  if (result.status === "stalled") {
    return {
      subject: `group ${result.group} stalled: ${clipped(result.reasons[0] ?? "no member can progress").slice(0, 120)}`,
      body: [...lines, "Stalled:", ...result.reasons.map((reason) => `- ${clipped(reason)}`)].join("\n"),
    };
  }
  return {
    subject: `group ${result.group} failed: ${clipped(result.error).slice(0, 120)}`,
    body: [...lines, `Failed: ${clipped(result.error)}`].join("\n"),
  };
}
