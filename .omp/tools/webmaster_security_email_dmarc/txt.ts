import { apexOf } from "./check";
import type { DnsResolver } from "./resolver";

/** The TXT records one name answered with. `error` means the lookup gave no answer (SERVFAIL, timeout), not "no record". */
export interface TxtEntry {
  name: string;
  role: "apex" | "label";
  txt: string[];
  error?: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The TXT records of one name; never throws: a failed lookup is kept as the entry's `error`. */
export async function txtEntry(name: string, role: TxtEntry["role"], resolver: DnsResolver): Promise<TxtEntry> {
  try {
    return { name, role, txt: [...await resolver.txt(name)] };
  } catch (error) {
    return { name, role, txt: [], error: `TXT: ${messageOf(error)}` };
  }
}

/**
 * The TXT records of a site's apex and of `<label>.<apex>` for each label (`_dmarc`, `google._domainkey`). Collects
 * only; never throws: a failed lookup is kept as that entry's `error`.
 */
export function collectTxt(site: string, labels: readonly string[], resolver: DnsResolver): Promise<TxtEntry[]> {
  const apex = apexOf(site);
  return Promise.all([
    txtEntry(apex, "apex", resolver),
    ...[...new Set(labels)].map((label) => txtEntry(`${label}.${apex}`, "label", resolver)),
  ]);
}

export const NO_NAMES_REASON = "no DNS records were collected for this site";

/** The apex entry the records of the site's own domain are read from, or why they could not be read. */
export function apexEntry(
  site: string,
  entries: readonly TxtEntry[] | undefined,
): TxtEntry | { readonly unmeasured: string } {
  const apex = entries?.find((entry) => entry.role === "apex");
  if (apex === undefined) return { unmeasured: NO_NAMES_REASON };
  if (apex.error !== undefined && apex.txt.length === 0) return { unmeasured: `${apexOf(site)}: ${apex.error}` };
  return apex;
}

/** The entry for `<label>.<apex>`, if the collection holds it. */
export const entryNamed = (entries: readonly TxtEntry[] | undefined, name: string): TxtEntry | undefined =>
  entries?.find((entry) => entry.name === name);
