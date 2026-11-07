import { securityFinding, type Severity, type Verdict } from "./check.ts";
import { succeeded } from "./net.ts";
import type { SitePublicFiles } from "./public_files.ts";

export const CHECK = "webmaster.security.site.exposed_files";

export type ExposedKind = "dump" | "env" | "git" | "log" | "phpinfo" | "archive" | "backup";

/** What a path segment is, by name: the stray-file kinds. */
const KIND_PATTERNS: readonly (readonly [ExposedKind, RegExp])[] = [
  ["git", /^\.git$/i],
  ["env", /^\.env(\..+)?$/i],
  ["dump", /\.sql(\.gz)?$/i],
  ["log", /\.log$/i],
  ["phpinfo", /^(php[-_]?info\d*|info|pi)\.php$/i],
  ["archive", /\.(zip|tar|tar\.gz|tgz|rar|7z)$/i],
  ["backup", /(\.(bak|old|orig|swp)|~)$/i],
];
/** Kinds that expose data (high); the rest expose source (medium). */
const DATA_KINDS: ReadonlySet<ExposedKind> = new Set(["dump", "env", "git", "log", "phpinfo"]);
/** Content labels that expose data, when the path itself names no kind. */
const DATA_LABELS = new Set([
  "credentials",
  "PHP source",
  "environment file",
  "database dump",
  "git metadata",
  "PHP configuration page",
  "debug log",
]);

/** The kind of the first path segment that names one, or undefined. */
export function exposedKindOf(path: string): ExposedKind | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    const kind = KIND_PATTERNS.find(([, pattern]) => pattern.test(segment))?.[0];
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** How bad one exposed file is: by its path's kind, else by what it served. */
export function exposureSeverity(path: string, label: string): Severity {
  const kind = exposedKindOf(path);
  if (kind !== undefined) return DATA_KINDS.has(kind) ? "high" : "medium";
  return DATA_LABELS.has(label) ? "high" : "medium";
}

/** Exposure paths that answered with content. */
export function exposedVerdict(publicFiles: SitePublicFiles | undefined): Verdict {
  if (publicFiles?.status !== "measured") {
    return { unmeasured: publicFiles?.reason ?? "no public files were collected" };
  }
  const asked = publicFiles.files.filter((file) => file.purpose === "exposure");
  if (asked.length > 0 && asked.every((file) => file.status === 0)) {
    return { unmeasured: `no exposure path was answered: ${asked[0]?.error ?? "no answer"}` };
  }
  const exposed = asked.filter((file) => succeeded(file) && file.exposed !== undefined);
  if (exposed.length === 0) return [];
  const severities = exposed.map((file) => exposureSeverity(file.path, file.exposed ?? ""));
  return [
    securityFinding(
      "security.site.exposed_files",
      severities.includes("high") ? "high" : "medium",
      `${exposed.length} path(s) served what should never be public: ${exposed.map((file) => `${file.path} (${file.exposed})`).join(", ")}.`,
      "Deny these paths at the web server or the edge now, move the files out of the web root, and treat every password or key they showed as leaked: have the hosting agent rotate it.",
      "Keep source, backups and environment files outside the document root and turn off directory listings.",
    ),
  ];
}
