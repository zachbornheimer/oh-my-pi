import { apexOf } from "./check";

/**
 * The TXT records one name answered with: the part of a collected DNS name (`dns.ts` `DnsName`) the email checks read.
 * `error` means the lookup gave no answer (SERVFAIL, timeout), not "no record".
 */
export interface TxtEntry {
  name: string;
  role: string;
  txt: string[];
  error?: string;
}

export const NO_NAMES_REASON = "no DNS records were collected for this site";

/** The apex entry the records of the site's own domain are read from, or why they could not be read. */
export function apexEntry<T extends TxtEntry>(
  site: string,
  entries: readonly T[] | undefined,
): T | { readonly unmeasured: string } {
  const apex = entries?.find((entry) => entry.role === "apex");
  if (apex === undefined) return { unmeasured: NO_NAMES_REASON };
  if (apex.error !== undefined && apex.txt.length === 0) return { unmeasured: `${apexOf(site)}: ${apex.error}` };
  return apex;
}

/** The entry for `<label>.<apex>`, if the collection holds it (a name that answered nothing is not listed). */
export const entryNamed = <T extends TxtEntry>(entries: readonly T[] | undefined, name: string): T | undefined =>
  entries?.find((entry) => entry.name === name);
