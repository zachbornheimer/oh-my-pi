import { apexOf, securityFinding, type Verdict } from "./check";
import { apexEntry, entryNamed, type TxtEntry } from "./txt";

export const CHECK = "webmaster.security.email.dmarc";
/** A DMARC record starts with its `v=DMARC1` tag (RFC 7489 6.3). */
const DMARC_RECORD = /^\s*v\s*=\s*DMARC1\s*(;|$)/i;

/** The subdomain a domain's DMARC policy is published at, and its full name. */
export const DMARC_LABEL = "_dmarc";
export const dmarcName = (domain: string): string => `${DMARC_LABEL}.${domain}`;

/** The tags of a DMARC record, names lower-cased; a part with no `=` is skipped. */
export function dmarcTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (name !== "") tags[name] = part.slice(eq + 1).trim();
  }
  return tags;
}

/** The policy (`p=`, lower-cased) of the DMARC record among `txt`; undefined when there is no record. */
export function dmarcPolicy(txt: readonly string[]): string | undefined {
  const record = txt.find((entry) => DMARC_RECORD.test(entry));
  return record === undefined ? undefined : (dmarcTags(record)["p"] ?? "").toLowerCase();
}

/** The apex's DMARC policy: none published, or monitoring only. */
export function dmarcVerdict(site: string, entries: readonly TxtEntry[] | undefined): Verdict {
  const apex = apexEntry(site, entries);
  if ("unmeasured" in apex) return apex;
  const domain = apexOf(site);
  const entry = entryNamed(entries, dmarcName(domain));
  if (entry?.error !== undefined && entry.txt.length === 0) return { unmeasured: `${entry.name}: ${entry.error}` };
  const policy = dmarcPolicy(entry?.txt ?? []);
  if (policy === undefined) {
    return [securityFinding(
      "security.email.dmarc.missing",
      "medium",
      `${domain} publishes no DMARC record at ${dmarcName(domain)}, so spoofed mail is neither rejected nor reported.`,
      "Publish `v=DMARC1; p=quarantine; rua=mailto:<a mailbox you read>` at _dmarc.",
      "Move DMARC to `p=reject` once the reports show only the domain's own senders.",
    )];
  }
  if (policy === "none") {
    return [securityFinding(
      "security.email.dmarc.none",
      "medium",
      `${domain} publishes DMARC with p=none (${
        (entry?.txt ?? []).join(" | ")
      }): spoofed mail is reported but still delivered.`,
      "Raise the DMARC policy to `p=quarantine` once the reports show only the domain's own senders.",
      "End at `p=reject`.",
    )];
  }
  return [];
}
