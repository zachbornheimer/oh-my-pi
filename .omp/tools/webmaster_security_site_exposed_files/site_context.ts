import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What the owner's webmaster site files (one YAML file per site) say about a site: its address, its security settings and
 * how its server is reached. Read-only. Port of Mastra's `webmaster/site_context.ts` and the site-file lookups in
 * `runtime/cli/gather/webmaster.ts`; YAML is parsed with Bun's built-in parser.
 */

export const SITES_DIRECTORY_ENVIRONMENT = "WEBMASTER_SITES_DIR";
/** Where the webmaster CLI keeps one YAML file per site, under the home directory. */
const SITES_DIRECTORY_UNDER_HOME = "Developer/Zysys/webmaster/sites";

/** How the hosting agent reaches the site's server, from the site file's `host` block. */
export interface SiteServer {
  /** How the server is reached: `ssh`, or `ecs` for a container with no SSH. */
  transport: string;
  /** The SSH host alias or `user@host`, or the ECS service. */
  target: string;
  /** The WordPress root on the server. */
  wp_root: string;
  /** The command that runs WP-CLI as the site's user, when it is not `wp`. */
  wp_cli?: string;
  /** The prefix that runs a file command as the site's user. */
  file_prefix?: string;
  /** The site's php-fpm pool user; a credential file owned by anyone else is flagged. */
  php_fpm_user?: string;
}

/** What the site file says that a security check needs: its mail, its other names, its origin and its server. */
export interface SiteSecurity {
  defacement_patterns: string[];
  exposure_paths: string[];
  hostnames: string[];
  origin?: string;
  mail_domains: string[];
  dkim_selectors: string[];
  known_mu_plugins: string[];
  debug_file_patterns: string[];
  tls_warn_days?: number;
  server?: SiteServer;
}

/** What is known about the site a URL belongs to, read from its site file. */
export interface SiteContext {
  name: string;
  url: string;
  host: string;
  tier?: string;
  platform?: string;
  probe_paths: string[];
  private_paths: string[];
  sitemap_disallow: string[];
  security?: SiteSecurity;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** A field that must be absent or the given type; anything else makes the file not a site file. */
function required<T>(block: Json, key: string, ok: (value: unknown) => value is T, what: string): T | undefined {
  const value = block[key];
  if (value === undefined || value === null) return undefined;
  if (!ok(value)) throw new Error(`${key}: expected ${what}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const optionalObject = (block: Json, key: string): Json | undefined => {
  const value = block[key];
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error(`${key}: expected a mapping`);
  return value;
};

/** A block that feeds only the security check: a malformed one is ignored, never a reason to refuse the site. */
const lenient = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const hostOfAddress = (address: string): string | undefined => {
  try {
    return new URL(address).host;
  } catch {
    return undefined;
  }
};

function serverOf(block: Json | undefined): SiteServer | undefined {
  if (block === undefined) return undefined;
  const { transport, target, wp_root, wp_cli, file_prefix, php_fpm_user } = block;
  if (!isString(transport) || !isString(target) || !isString(wp_root)) return undefined;
  return {
    transport,
    target,
    wp_root,
    ...(isString(wp_cli) ? { wp_cli } : {}),
    ...(isString(file_prefix) ? { file_prefix } : {}),
    ...(isString(php_fpm_user) ? { php_fpm_user } : {}),
  };
}

function securityOf(file: Json): SiteSecurity | undefined {
  const security = lenient(() => optionalObject(file, "security"));
  const mail = lenient(() => optionalObject(file, "mail"));
  const uptime = lenient(() => optionalObject(file, "uptime"));
  const host = lenient(() => optionalObject(file, "host"));
  const aliasesValue = uptime?.["aliases"];
  const aliasesGiven = isStrings(aliasesValue);
  if (security === undefined && mail === undefined && !aliasesGiven && host === undefined) return undefined;
  const strings = (block: Json | undefined, key: string): string[] => {
    const value = block?.[key];
    return isStrings(value) ? value : [];
  };
  const aliases = (aliasesGiven ? aliasesValue : []).map(hostOfAddress).filter((name): name is string => name !== undefined);
  const server = serverOf(host);
  const origin = security?.["origin"];
  const warn = security?.["tls_warn_days"];
  return {
    defacement_patterns: strings(security, "defacement_patterns"),
    exposure_paths: strings(security, "exposure_paths"),
    hostnames: [...new Set([...strings(security, "hostnames"), ...aliases])],
    ...(isString(origin) ? { origin } : {}),
    mail_domains: strings(mail, "domains"),
    dkim_selectors: strings(mail, "dkim_selectors"),
    known_mu_plugins: strings(security, "known_mu_plugins"),
    debug_file_patterns: strings(security, "debug_file_patterns"),
    ...(typeof warn === "number" && Number.isInteger(warn) && warn > 0 ? { tls_warn_days: warn } : {}),
    ...(server === undefined ? {} : { server }),
  };
}

/** The context a site file describes; throws an Error naming `label` when the file is not a site. */
export function siteContextFrom(yamlText: string, name: string, label: string): SiteContext {
  try {
    const parsed: unknown = Bun.YAML.parse(yamlText);
    if (!isObject(parsed)) throw new Error("expected a mapping");
    const url = parsed["url"];
    if (!isString(url)) throw new Error("url: expected a string");
    const fileName = required(parsed, "name", isString, "a string");
    const tier = required(parsed, "tier", isString, "a string");
    const platform = required(parsed, "platform", isString, "a string");
    const probes = optionalObject(parsed, "probes");
    const flows = optionalObject(parsed, "flows");
    const sitemap = optionalObject(parsed, "sitemap");
    const probePaths = probes === undefined ? undefined : required(probes, "paths", isStrings, "a list of strings");
    const disallow = sitemap === undefined ? undefined : required(sitemap, "disallow", isStrings, "a list of strings");
    const flowPaths = ["login_path", "cart_path", "checkout_path"].map((key) =>
      flows === undefined ? undefined : required(flows, key, isString, "a string"),
    );
    const security = securityOf(parsed);
    return {
      name: fileName ?? name,
      url,
      host: new URL(url).host,
      ...(tier === undefined ? {} : { tier }),
      ...(platform === undefined ? {} : { platform }),
      probe_paths: probePaths ?? ["/"],
      private_paths: flowPaths.filter((path): path is string => path !== undefined),
      sitemap_disallow: disallow ?? [],
      ...(security === undefined ? {} : { security }),
    };
  } catch (error) {
    throw new Error(`${label} is not a webmaster site file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Where the owner's site files are: `WEBMASTER_SITES_DIR` when set, else `~/Developer/Zysys/webmaster/sites`. */
export function sitesDirectory(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const set = env[SITES_DIRECTORY_ENVIRONMENT];
  return set !== undefined && set !== "" ? set : join(home, SITES_DIRECTORY_UNDER_HOME);
}

const bareHost = (address: string): string => new URL(address).hostname.replace(/^www\./, "");

async function names(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
}

/**
 * The site file whose address has the same host as `site` (a domain or an address, with or without `www.`), when there
 * is one. A file that is not a site file is skipped. Reads files only.
 */
export async function siteContextForAddress(site: string, directory: string = sitesDirectory()): Promise<SiteContext | undefined> {
  let host: string;
  try {
    host = bareHost(/^https?:\/\//i.test(site) ? site : `https://${site}`);
  } catch {
    return undefined;
  }
  for (const file of await names(directory)) {
    try {
      const text = await readFile(join(directory, file), "utf8");
      const context = siteContextFrom(text, file.slice(0, -".yaml".length), file);
      if (bareHost(context.url) === host) return context;
    } catch {
      // A file that is not a site file names no site.
    }
  }
  return undefined;
}

/** The site a site-file name refers to, read from `<directory>/<name>.yaml`. Throws when the file is missing or not a site file. */
export async function siteContextNamed(name: string, directory: string = sitesDirectory()): Promise<SiteContext> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error(`"${name}" is not a site file name`);
  const path = join(directory, `${name}.yaml`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`site "${name}": no site file at ${path}`);
  }
  return siteContextFrom(text, name, path);
}
