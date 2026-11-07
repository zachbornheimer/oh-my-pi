import { apexOf, securityFinding, type Verdict } from "./check";
import { apexEntry, type TxtEntry } from "./txt";

export const CHECK = "webmaster.security.email.spf";
/** RFC 7208 4.6.4: an SPF check may trigger at most 10 DNS-querying terms. */
export const SPF_LOOKUP_LIMIT = 10;

const SPF_RECORD = /^v=spf1(\s|$)/i;
const LOOKUP_TERM = /^[+~?-]?(include:|a\b|a:|mx\b|mx:|ptr\b|ptr:|exists:|redirect=)/i;

/** The SPF records among a name's TXT records. */
export const spfRecords = (txt: readonly string[]): string[] => txt.filter((record) => SPF_RECORD.test(record));

/** How many DNS-querying terms an SPF record holds itself; the records its `include:` terms name are not read. */
export const spfLookups = (record: string): number =>
  record.split(/\s+/).slice(1).filter((term) => LOOKUP_TERM.test(term)).length;

/** The apex's SPF records: none, more than one, or one that needs too many lookups. */
export function spfVerdict(site: string, entries: readonly TxtEntry[] | undefined): Verdict {
  const apex = apexEntry(site, entries);
  if ("unmeasured" in apex) return apex;
  const domain = apexOf(site);
  const records = spfRecords(apex.txt);
  const [first] = records;
  const lookups = first === undefined ? 0 : spfLookups(first);
  return [
    ...records.length > 0 ? [] : [securityFinding(
      "security.email.spf.missing",
      "medium",
      `${domain} publishes no SPF record, so anyone can send as it.`,
      "Publish a `v=spf1` record that lists the domain's real senders and ends in `~all` or `-all`.",
      "Keep the SPF record in step with the services that send mail for the domain.",
    )],
    ...records.length < 2 ? [] : [securityFinding(
      "security.email.spf.duplicate",
      "high",
      `${domain} has ${records.length} SPF records (${
        records.join(" | ")
      }). Two SPF records are a permanent error, so receivers fail SPF for every message.`,
      "Merge the records into one `v=spf1` record in DNS.",
      "Keep exactly one SPF record per domain and add senders as `include:` terms to it.",
    )],
    ...lookups <= SPF_LOOKUP_LIMIT ? [] : [securityFinding(
      "security.email.spf.lookups",
      "high",
      `${domain}'s SPF record needs ${lookups} DNS lookups; the limit is ${SPF_LOOKUP_LIMIT}, and receivers treat more as an error.`,
      "Flatten or drop `include:` terms until the record needs 10 lookups or fewer.",
      "Review the SPF record whenever a sending service is added.",
    )],
  ];
}
