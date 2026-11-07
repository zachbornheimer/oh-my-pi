import { ask, type HttpAnswer, inBatches, type NetAnswer, recorded, type SecurityNet, succeeded } from "./net.ts";

/**
 * What a site serves at paths that should never serve content (a label of what each is, never the body) and at the
 * pages defacers drop (body kept, secret-looking values redacted). GET only; never throws for a site that does not
 * answer. Port of Mastra's `webmaster.site.public_files` schemas and `security/public_files.ts`.
 */

/** Paths that should never answer with content on any site. */
export const EXPOSURE_PATHS = [
  "/dev/",
  "/.git/HEAD",
  "/.env",
  "/phpinfo.php",
  "/info.php",
  "/wp-config.php.bak",
  "/wp-config.php~",
  "/wp-config.php.save",
  "/wp-config.php.old",
  "/wp-config.bak",
  "/backup/",
  "/backups/",
  "/backup.zip",
  "/backup.sql",
  "/backup.tar.gz",
  "/wp-content/uploads/",
  "/wp-content/debug.log",
] as const;

/** Names defacers commonly drop a page under. */
export const DROP_PATHS = ["/0x.html", "/x.html", "/1.html", "/hacked.html", "/hacked.htm", "/deface.html", "/index.html"] as const;

/** The most extra exposure paths one call may add to the built-in list. */
export const MAX_EXTRA_PATHS = 50;

export type FilePurpose = "exposure" | "drop";

export interface PublicFile extends HttpAnswer {
  /** `exposure`: a path that should never serve content (its body is never kept). `drop`: a page a defacer leaves. */
  purpose: FilePurpose;
  /** For an `exposure` path that answered with content: what the content is (`PHP source`, `environment file`, ...). */
  exposed?: string;
}

export type SitePublicFiles =
  | { status: "measured"; files: PublicFile[] }
  | { status: "unmeasured"; reason: string };

const REQUESTS_AT_ONCE = 6;

/** What an exposed path's content is, by the first signature it matches; only this label is kept, never the body. */
const EXPOSURE_SIGNATURES: readonly {
  readonly what: string;
  readonly matches: (answer: { readonly path: string; readonly contentType: string; readonly body: string }, html: boolean) => boolean;
}[] = [
  { what: "directory listing", matches: (a) => /<title>\s*Index of \/|Directory listing for/i.test(a.body) },
  { what: "git metadata", matches: (a) => /^ref: refs\//m.test(a.body) },
  { what: "PHP source", matches: (a) => /<\?php/.test(a.body) || /define\(\s*['"][A-Z][A-Z0-9_]*['"]/.test(a.body) },
  { what: "PHP configuration page", matches: (a) => /<title>phpinfo\(\)<\/title>|PHP Version \d/.test(a.body) },
  {
    what: "environment file",
    matches: (a, html) => !html && (a.body.match(/^[A-Z][A-Z0-9_]*=.*$/gm)?.length ?? 0) >= 2,
  },
  { what: "credentials", matches: (a, html) => !html && /DB_PASSWORD|DB_USER/.test(a.body) },
  { what: "database dump", matches: (a) => /^-- (MySQL|MariaDB) dump|CREATE TABLE `/m.test(a.body) },
  { what: "debug log", matches: (a) => /PHP (Fatal error|Warning|Notice|Parse error|Deprecated)/.test(a.body) },
  {
    what: "archive",
    matches: (a) =>
      a.body.startsWith("PK\u0003\u0004") ||
      (/zip|gzip|x-tar|sql|octet-stream/i.test(a.contentType) && /\.(zip|gz|tgz|tar|sql)$/i.test(a.path)),
  },
];

/** What an exposed path serves, or undefined when its content is nothing that should be private. */
export function exposureSignature(path: string, answer: NetAnswer): string | undefined {
  const html = /html/i.test(answer.contentType) || /^\s*</.test(answer.body);
  const read = { path, contentType: answer.contentType, body: answer.body };
  return EXPOSURE_SIGNATURES.find((signature) => signature.matches(read, html))?.what;
}

/** The extra paths as asked: each a site path (`/x`), none an address for another host (`//host/x`, `http://...`). */
export function validatedExposurePaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  const bad = unique.find((path) => !/^\/(?!\/)[^\s\\]*$/.test(path));
  if (bad !== undefined) throw new Error(`exposure path "${bad}" must be a path of the site starting with a single "/" and holding no spaces`);
  if (unique.length > MAX_EXTRA_PATHS) throw new Error(`at most ${MAX_EXTRA_PATHS} extra exposure paths, got ${unique.length}`);
  return unique;
}

async function exposure(net: SecurityNet, siteUrl: string, path: string, signal?: AbortSignal): Promise<PublicFile> {
  const answered = await ask(net, siteUrl, { method: "GET", path }, () => false, signal);
  const exposed = answered.raw !== undefined && succeeded(answered) ? exposureSignature(path, answered.raw) : undefined;
  return { ...recorded(answered), purpose: "exposure", ...(exposed === undefined ? {} : { exposed }) };
}

export async function drop(net: SecurityNet, siteUrl: string, path: string, signal?: AbortSignal): Promise<PublicFile> {
  const answered = await ask(net, siteUrl, { method: "GET", path }, (answer) => answer.status >= 200 && answer.status < 300, signal);
  return { ...recorded(answered), purpose: "drop" };
}

/** What the site serves at the exposure paths (a label, never the body) and the drop pages. GET only; never throws unless cancelled. */
export async function measurePublicFiles(
  target: { readonly siteUrl: string; readonly exposurePaths?: readonly string[] },
  net: SecurityNet,
  signal?: AbortSignal,
): Promise<SitePublicFiles> {
  const exposurePaths = [...new Set([...EXPOSURE_PATHS, ...(target.exposurePaths ?? [])])];
  const files = [
    ...(await inBatches(exposurePaths, REQUESTS_AT_ONCE, (path) => exposure(net, target.siteUrl, path, signal))),
    ...(await inBatches(DROP_PATHS, REQUESTS_AT_ONCE, (path) => drop(net, target.siteUrl, path, signal))),
  ];
  if (files.every((file) => file.status === 0)) {
    return { status: "unmeasured", reason: `${target.siteUrl} did not answer: ${files[0]?.error ?? "no request was sent"}` };
  }
  return { status: "measured", files };
}
