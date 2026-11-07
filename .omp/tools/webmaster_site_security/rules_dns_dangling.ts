import { apexOf, securityFinding, type Verdict } from "./check";
import type { DnsName } from "./dns";

export const CHECK = "webmaster.security.dns.dangling";
export const NO_NAMES_REASON = "no DNS records were collected for this site";

/** Third-party services a CNAME can point at; they only name the service in the evidence. */
export const HOSTING_PROVIDERS: readonly { readonly name: string; readonly target: RegExp }[] = [
  { name: "Leadpages", target: /(\.leadpages\.(co|net)|(^|\.)lpages\.co)\.?$/i },
  { name: "Heroku", target: /\.(herokuapp|herokudns)\.com\.?$/i },
  { name: "Amazon S3", target: /(\.s3[.-][a-z0-9-.]*amazonaws\.com|(^|\.)s3-website[.-])/i },
  { name: "GitHub Pages", target: /\.github\.io\.?$/i },
  { name: "Azure", target: /\.(azurewebsites\.net|cloudapp\.net|trafficmanager\.net|blob\.core\.windows\.net)\.?$/i },
  { name: "Shopify", target: /\.myshopify\.com\.?$/i },
  { name: "Netlify", target: /\.netlify\.(app|com)\.?$/i },
  { name: "Vercel", target: /(\.vercel\.app|(^|\.)vercel-dns\.com)\.?$/i },
  { name: "Fastly", target: /(^|\.)fastly\.net\.?$/i },
  { name: "Unbounce", target: /(^|\.)unbouncepages\.com\.?$/i },
  { name: "Zendesk", target: /\.zendesk\.com\.?$/i },
  { name: "HubSpot", target: /((^|\.)hubspot\.net|(^|\.)hs-sites\.com)\.?$/i },
];

/** A CNAME whose chain ends at a name that does not exist, and whose lookup did not fail. */
const dangles = (entry: DnsName): boolean =>
  entry.error === undefined && entry.cname.length > 0 && entry.nxdomain === true;

const describe = (entry: DnsName): string => {
  const target = entry.cname.at(-1) ?? "";
  const provider = HOSTING_PROVIDERS.find((candidate) => candidate.target.test(target));
  return `${entry.name} -> ${target} (${provider === undefined ? "" : `${provider.name}; `}the target does not exist)`;
};

/** The CNAMEs whose target does not exist; a wildcard record that dangles is one item, not one per guessed name. */
export function danglingVerdict(site: string, names: readonly DnsName[] | undefined): Verdict {
  if (names === undefined || names.length === 0) return { unmeasured: NO_NAMES_REASON };
  // Every lookup failing (no network, a dead resolver) leaves nothing that dangles, which is not a clean zone.
  const apex = names.find((entry) => entry.role === "apex");
  if (apex === undefined) return { unmeasured: NO_NAMES_REASON };
  if (apex.error !== undefined && [apex.a, apex.aaaa, apex.cname, apex.mx, apex.ns, apex.txt].every((r) => r.length === 0)) {
    return { unmeasured: `${apexOf(site)}: ${apex.error}` };
  }
  const broken = names.filter(dangles);
  const wildcard = broken.find((entry) => entry.wildcard === true);
  const items = [
    ...broken.filter((entry) => entry.wildcard !== true).map(describe),
    ...wildcard === undefined ? [] : [describe({ ...wildcard, name: `*.${apexOf(site)}` })],
  ];
  if (items.length === 0) return [];
  return [securityFinding(
    "security.dns.dangling",
    "high",
    "CNAMEs point at names that no longer exist, so anyone who claims the name at its service serves pages as this "
      + `site: ${items.join("; ")}.`,
    "Delete these DNS records now, or claim the name back at the provider before anyone else does.",
    "Remove a DNS record in the same change that cancels the service it points at.",
  )];
}
