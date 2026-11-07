import { apexOf, securityFinding, type Verdict } from "./check";
import { apexEntry, entryNamed, type TxtEntry } from "./txt";

export const CHECK = "webmaster.security.email.dkim";

/**
 * The selectors common mail providers sign with, asked at every domain besides the caller's own: Google, Microsoft 365,
 * Mailchimp's Mandrill, Proton, Zoho (and its alternate `zmail`), SendGrid, Fastmail (`fm1`-`fm3`) and plain names.
 */
export const DKIM_SELECTORS: readonly string[] = [
  "default",
  "google",
  "selector1",
  "selector2",
  "k1",
  "k2",
  "s1",
  "s2",
  "mail",
  "dkim",
  "smtp",
  "mandrill",
  "protonmail",
  "protonmail2",
  "protonmail3",
  "zoho",
  "zohomail",
  "zmail",
  "fm1",
  "fm2",
  "fm3",
];

/** A selector is one or more DNS labels (RFC 6376 3.1): letters, digits and hyphens, dot-separated, 63 bytes a label. */
const SELECTOR = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The caller's own selectors, trimmed and lower-cased. Throws on one that is not a valid selector, before any query is made. */
export function validSelectors(selectors: readonly string[] = []): string[] {
  return selectors.map((selector) => {
    const name = selector.trim().toLowerCase();
    if (!SELECTOR.test(name)) {
      throw new Error(`dkim_selectors must be DNS labels such as \`google\` or \`s1\`; got ${JSON.stringify(selector)}`);
    }
    return name;
  });
}

/** The selectors to ask: the common ones and the caller's own, each once. */
export const selectorsToAsk = (extra: readonly string[] = []): string[] => [...new Set([...DKIM_SELECTORS, ...extra])];

/** The subdomain a selector's key is published at, and its full name. */
export const dkimLabel = (selector: string): string => `${selector}._domainkey`;
export const dkimName = (selector: string, domain: string): string => `${dkimLabel(selector)}.${domain}`;

/**
 * Whether TXT records hold a DKIM key (RFC 6376 3.6.1): `v=`, when present, is `DKIM1`, and `p=` carries key data. An
 * empty `p=` is a revoked key; a record with no `p=` (an SPF record a wildcard answers with) is no key.
 */
export function isDkimKey(txt: readonly string[]): boolean {
  return txt.some((record) => {
    const tags = new Map(
      record.split(";").map((tag) => {
        const [name = "", ...value] = tag.split("=");
        return [name.trim().toLowerCase(), value.join("=").trim()] as const;
      }),
    );
    const version = tags.get("v");
    return (version === undefined || version === "DKIM1") && (tags.get("p") ?? "") !== "";
  });
}

/** The apex's DKIM keys: none at any selector asked. A lookup that failed leaves the verdict unmeasured. */
export function dkimVerdict(site: string, entries: readonly TxtEntry[] | undefined, extra: readonly string[] = []): Verdict {
  const apex = apexEntry(site, entries);
  if ("unmeasured" in apex) return apex;
  const domain = apexOf(site);
  const selectors = selectorsToAsk(extra);
  const found = selectors.flatMap((selector) => entryNamed(entries, dkimName(selector, domain)) ?? []);
  if (found.some((entry) => isDkimKey(entry.txt))) return [];
  const failed = found.filter((entry) => entry.error !== undefined);
  if (failed.length > 0) {
    return { unmeasured: `${failed.map((entry) => entry.name).join(", ")}: lookup failed (${failed[0]?.error ?? ""})` };
  }
  return [securityFinding(
    "security.email.dkim.missing",
    "medium",
    `${domain}: no DKIM key at any selector asked (${selectors.join(", ")}).`,
    "Turn on DKIM signing at the mail provider and publish the key it gives you.",
    "Pass the domain's own selector (`dkim_selectors`) so the right one is asked.",
  )];
}
