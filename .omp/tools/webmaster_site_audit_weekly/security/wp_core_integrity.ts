import { listed, securityFinding, type Verdict } from "./check";
import { ranOutput, unreadable } from "./wp_cli";
import { type WordpressInspect } from "./inspect";

export const CHECK = "webmaster.security.wordpress.core_integrity";

export interface ChecksumReport {
  readonly verified: boolean;
  readonly modified: readonly string[];
  readonly unexpected: readonly string[];
}

/** What `wp core verify-checksums` reported: files that differ from the release, and files that should not exist. */
export function parseChecksums(exitCode: number, text: string): ChecksumReport {
  const files = (pattern: RegExp) => [...text.matchAll(pattern)].map((match) => (match[1] ?? "").trim());
  return {
    verified: exitCode === 0,
    modified: files(/File doesn't verify against checksum:\s*(.+)/g),
    unexpected: files(/File should not exist:\s*(.+)/g),
  };
}

/** Core files that differ from the release or should not exist. */
export function coreIntegrityVerdict(inspect: WordpressInspect | undefined): Verdict {
  if (inspect?.status !== "measured") return { unmeasured: inspect?.reason ?? "the server was not inspected" };
  const output = ranOutput(inspect, "core_checksums");
  if ("unmeasured" in output) return output;
  const report = parseChecksums(output.code, `${output.stdout}\n${output.stderr}`);
  const files = [...report.modified, ...report.unexpected];
  if (files.length === 0) return report.verified ? [] : unreadable(output);
  return [securityFinding(
    "security.wordpress.core_integrity",
    "high",
    `${files.length} WordPress core file(s) differ from the release or should not exist: ${listed(files)}.`,
    "Hand the site to the hosting agent: changed core files mean an attacker could write PHP. Do not trust the "
      + "install until it is reinstalled from the release and the entry point is closed.",
    "Reinstall core from the release (`wp core download --force --skip-content`) after the cause is found.",
  )];
}
