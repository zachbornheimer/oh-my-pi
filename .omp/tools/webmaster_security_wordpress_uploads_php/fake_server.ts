import { basename, dirname } from "node:path";
import type { ProcessResult, RunProcess } from "./inspect.ts";

/** What a WordPress server holds, as far as the inspection's fixed commands can tell. */
export interface ServerLayout {
  /** What WordPress names as its folders; `"unresolvable"` makes the `wp eval` that asks fail. */
  readonly contentDirectories: { readonly plugins: string; readonly uploads: string; readonly themes: string } | "unresolvable";
  /** Every directory that exists, and whether it changed within the recent days. */
  readonly directories: Readonly<Record<string, { readonly recent: boolean }>>;
  /** Every file that exists, by absolute path. */
  readonly files: readonly string[];
  /** Directories `find` cannot read (it reports them and exits 1, still printing the rest). */
  readonly unreadable?: readonly string[];
  readonly coreVersion?: string;
  /** What the `update_discovery` command prints. */
  readonly updateDiscovery?: string;
}

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });

/** The site's WordPress root in the layouts below. */
export const WP_ROOT = "/var/www/vhosts/example.org/httpdocs";
/** The site that moved its content folder: `define("WP_CONTENT_DIR", ABSPATH . "zycms")`, with a leftover `wp-content`. */
export const CONTENT = `${WP_ROOT}/zycms`;

export interface RecordedRun {
  readonly commandLine: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * A scripted WordPress server behind SSH: answers the inspection's fixed commands from a layout, running `find` against
 * that layout's directories as the real one does (a missing folder is `No such file or directory`, exit 1). Any command
 * it does not know prints nothing and succeeds. Never opens a connection.
 */
export class FakeWordpressServer {
  readonly runs: RecordedRun[] = [];
  constructor(private readonly layout: ServerLayout) {}

  readonly run: RunProcess = async (command, args) => {
    this.runs.push({ commandLine: [command, ...args].join(" "), command, args });
    // A PHP program travels as base64 on one line (`printf %s '<base64>' | base64 -d | wp eval-file -`): read it as PHP.
    const remote = (args.at(-1) ?? "").replace(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/, (_, encoded: string) =>
      Buffer.from(encoded, "base64").toString(),
    );
    if (/(^|\s)find\s/.test(remote)) return this.find(remote.split(/\s+/));
    if (remote.includes("WP_PLUGIN_DIR")) {
      const { contentDirectories } = this.layout;
      return contentDirectories === "unresolvable"
        ? { code: 1, stdout: "", stderr: "Error: This does not seem to be a WordPress installation." }
        : ok(`plugins=${contentDirectories.plugins}\nuploads=${contentDirectories.uploads}\nthemes=${contentDirectories.themes}\n`);
    }
    if (remote.includes("wp_version_check")) return ok(this.layout.updateDiscovery ?? "");
    if (remote.endsWith(" core version")) return ok(`${this.layout.coreVersion ?? "6.7.1"}\n`);
    return ok("[]");
  };

  private find(words: readonly string[]): ProcessResult {
    const options = words.slice(words.indexOf("find") + 1);
    const root = options.find((word) => !word.startsWith("-")) ?? "";
    const { directories, files, unreadable = [] } = this.layout;
    if (!(root in directories)) {
      return { code: 1, stdout: "", stderr: `find: '${root}': No such file or directory\n` };
    }
    const printed = options.includes("-iname")
      ? files.filter((file) => file.startsWith(`${root}/`) && /\.ph/i.test(basename(file)))
      : Object.entries(directories).filter(([path, entry]) => dirname(path) === root && entry.recent).map(([path]) => path);
    const denied = unreadable.filter((path) => path.startsWith(`${root}/`));
    return {
      code: denied.length > 0 ? 1 : 0,
      stdout: printed.map((path) => `${path}\n`).join(""),
      stderr: denied.map((path) => `find: '${path}': Permission denied\n`).join(""),
    };
  }
}

/** A site whose content lives in `zycms`, not `wp-content`: the leftover `wp-content` holds no plugins or uploads. */
export function zycmsLayout(overrides: Partial<ServerLayout> = {}): ServerLayout {
  return {
    contentDirectories: { plugins: `${CONTENT}/plugins`, uploads: `${CONTENT}/uploads`, themes: `${CONTENT}/themes` },
    directories: {
      [`${WP_ROOT}/wp-content`]: { recent: false },
      [CONTENT]: { recent: false },
      [`${CONTENT}/plugins`]: { recent: false },
      [`${CONTENT}/plugins/akismet`]: { recent: false },
      [`${CONTENT}/plugins/wp-file-manager`]: { recent: true },
      [`${CONTENT}/uploads`]: { recent: false },
      [`${CONTENT}/uploads/2026`]: { recent: false },
      [`${CONTENT}/themes`]: { recent: false },
      [`${CONTENT}/themes/twentytwentyfour`]: { recent: false },
      [`${CONTENT}/themes/twentytwentyfour-child`]: { recent: true },
    },
    files: [`${CONTENT}/uploads/2026/cache-1.php`, `${CONTENT}/uploads/2026/photo.jpg`],
    ...overrides,
  };
}
