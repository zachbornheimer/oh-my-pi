import { hostPreamble, shellQuote, WP_FUNCTION } from "./script.ts";
import type { SiteServer } from "./site_context.ts";

/**
 * A fixed list of read-only commands run over SSH on the host the site file names. Read-only by construction: the
 * commands are built here from constants, the only values taken from the site (host, WordPress root, WP-CLI and file
 * prefixes) must be plain words, and nothing else can be asked for. Off unless `WEBMASTER_SECURITY_SERVER=1`.
 * Authentication is the SSH agent's: no password, key or token is read from a file or the environment. Port of
 * Mastra's `webmaster.wordpress.inspect` schemas and `runtime/cli/gather/security/wordpress_inspect.ts`.
 */

/** The fixed read-only commands the tool runs on the site's server, by name. */
export const INSPECT_COMMANDS = [
  "core_checksums",
  "plugin_checksums",
  "administrators",
  "must_use_plugins",
  "cron_events",
  "core_version",
  "update_discovery",
  "plugin_list",
  "theme_list",
  "content_directories",
  "uploads_php",
  "plugin_directories",
  "theme_directories",
] as const;
export type InspectCommand = (typeof INSPECT_COMMANDS)[number];

export interface InspectOutput {
  /** Which fixed command ran. */
  command: InspectCommand;
  /** The command as sent, for the record. */
  command_line: string;
  /** The command's exit code. */
  code: number;
  stdout: string;
  stderr: string;
}

export type WordpressInspect =
  | { status: "measured"; measured_at: string; recent_days: number; outputs: InspectOutput[] }
  | { status: "unmeasured"; reason: string };

export type MeasuredInspect = Extract<WordpressInspect, { status: "measured" }>;

export const SERVER_GATHER_ENVIRONMENT = "WEBMASTER_SECURITY_SERVER";
export const SERVER_OFF_REASON =
  "server checks are off; set WEBMASTER_SECURITY_SERVER=1 to run the read-only SSH inspection";
/** How many days back counts as recent for changed plugin directories and new administrators. */
export const RECENT_DAYS = 14;
/** The longest one command may run before it is stopped and recorded as not run. */
export const COMMAND_TIMEOUT_MS = 300_000;

export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"] as const;
/** A word a site file may contribute to a command: no spaces, quotes, `;`, `|`, `&`, `$`, backticks or redirects. */
export const PLAIN_WORD = /^[A-Za-z0-9_./@:=+-]+$/;
export const SSH_FAILED = 255;

/** What a finished process left behind. `code` is -1 when the process could not start or was stopped. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a process and never throws for a non-zero exit; a cancelled run throws. */
export type RunProcess = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<ProcessResult>;

export interface InspectCommandLine {
  readonly command: InspectCommand;
  /** The command line the remote shell runs. */
  readonly remote: string;
}

export function plainWords(value: string, field: string): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const unsafe = words.find((word) => !PLAIN_WORD.test(word));
  if (unsafe !== undefined) throw new Error(`the site file's host.${field} has "${unsafe}", which is not a plain word`);
  return words;
}

/** The commands each site file's values are put into: WP-CLI as the site user, and files read as the site user. */
export function commandBuilders(server: SiteServer) {
  const wp = plainWords(server.wp_cli ?? "wp", "wp_cli");
  const prefix = plainWords(server.file_prefix ?? "", "file_prefix");
  const [root] = plainWords(server.wp_root, "wp_root");
  if (root === undefined) throw new Error("the site file's host.wp_root is empty");
  // The construction `webmaster wp` proved on WP Engine and Plesk: `cd <wp_root>` when the login user can (WP Engine's
  // wrapper finds the site from the working directory and rejects --path), `--path` otherwise. wp_root may be relative.
  const preamble = hostPreamble({ wpRoot: root, wpCli: wp.join(" ") }).join("; ");
  const word = (value: string) => (PLAIN_WORD.test(value) ? value : shellQuote(value));
  const call = (flags: readonly string[], args: readonly string[]) =>
    `${preamble}; ${WP_FUNCTION} ${[...flags, ...args].map(word).join(" ")}`;
  /**
   * A PHP program on stdin through `eval-file -`, carried as base64 on one line: no quote, paren or `$` in it reaches a
   * shell, and no newline (WP Engine's SSH gateway runs the whole command as one `bash -c` line, which a heredoc breaks).
   */
  const program = (flags: readonly string[], php: string) =>
    `${preamble}; printf %s ${shellQuote(Buffer.from(`<?php\n${php}\n`).toString("base64"))} | base64 -d | ${WP_FUNCTION} ${
      [...flags, "eval-file", "-"].join(" ")
    }`;
  return {
    /** WP-CLI with plugins and themes left unloaded: nothing a site adds runs. */
    wpCli: (...args: string[]) => call(["--skip-plugins", "--skip-themes"], args),
    /** WP-CLI with the site's plugins and themes loaded, for the commands that read what they hook. */
    wpCliLoaded: (...args: string[]) => call([], args),
    wpEval: (php: string) => program(["--skip-plugins", "--skip-themes"], php),
    wpEvalLoaded: (php: string) => program([], php),
    asSiteUser: (...args: string[]) => [...prefix, ...args].join(" "),
  };
}

/** What WordPress itself says its plugin, uploads and themes folders are: not always under `wp-content`. */
const CONTENT_DIRECTORIES_PHP =
  "echo \"plugins=\", WP_PLUGIN_DIR, \"\\nuploads=\", wp_upload_dir(null, false)[\"basedir\"], \"\\nthemes=\", get_theme_root(), \"\\n\";";

/**
 * The filters that can blind or stop WordPress' own update discovery, who hooked them, the constants that turn the
 * updater off, and when the version-check cron runs. Read straight from the loaded hooks, never from `wp core
 * check-update`, which those filters can answer for.
 */
const UPDATE_DISCOVERY_PHP = [
  "global $wp_filter; $hooks = array();",
  "foreach (array(\"pre_site_transient_update_core\", \"pre_site_transient_update_plugins\", \"auto_update_core\", \"automatic_updater_disabled\") as $hook) {",
  "$hooks[$hook] = array();",
  "if (!isset($wp_filter[$hook])) { continue; }",
  "foreach ($wp_filter[$hook]->callbacks as $callbacks) { foreach ($callbacks as $callback) {",
  "$function = $callback[\"function\"]; $name = \"\"; $file = \"\";",
  "try {",
  "if ($function instanceof Closure) { $name = \"{closure}\"; $reflection = new ReflectionFunction($function); }",
  "elseif (is_array($function)) { $name = (is_object($function[0]) ? get_class($function[0]) : $function[0]) . \"::\" . $function[1]; $reflection = new ReflectionMethod($function[0], $function[1]); }",
  "else { $name = (string) $function; $reflection = new ReflectionFunction($function); }",
  "$file = (string) $reflection->getFileName();",
  "} catch (Throwable $error) {}",
  "$hooks[$hook][] = array(\"callback\" => $name, \"file\" => $file);",
  "} }",
  "}",
  "$event = wp_get_scheduled_event(\"wp_version_check\");",
  "echo json_encode(array(\"hooks\" => $hooks, \"constants\" => array(",
  "\"AUTOMATIC_UPDATER_DISABLED\" => defined(\"AUTOMATIC_UPDATER_DISABLED\") ? constant(\"AUTOMATIC_UPDATER_DISABLED\") : null,",
  "\"WP_AUTO_UPDATE_CORE\" => defined(\"WP_AUTO_UPDATE_CORE\") ? constant(\"WP_AUTO_UPDATE_CORE\") : null),",
  "\"version_check\" => $event ? array(\"timestamp\" => $event->timestamp, \"interval\" => $event->interval ? $event->interval : 0) : null,",
  "\"now\" => time()));",
].join(" ");

/** The fixed read-only commands that need nothing from the server first; throws naming the field when a value is not plain. */
export function inspectCommands(server: SiteServer): InspectCommandLine[] {
  const { wpCli, wpCliLoaded, wpEval, wpEvalLoaded } = commandBuilders(server);
  return [
    { command: "core_checksums", remote: wpCli("core", "verify-checksums") },
    { command: "plugin_checksums", remote: wpCli("plugin", "verify-checksums", "--all", "--format=json") },
    {
      command: "administrators",
      remote: wpCli("user", "list", "--role=administrator", "--fields=ID,user_login,user_registered", "--format=json"),
    },
    { command: "must_use_plugins", remote: wpCli("plugin", "list", "--fields=name,status", "--format=json") },
    {
      command: "cron_events",
      remote: wpCli("cron", "event", "list", "--fields=hook,next_run_relative,recurrence", "--format=json"),
    },
    { command: "core_version", remote: wpCli("core", "version") },
    { command: "update_discovery", remote: wpEvalLoaded(UPDATE_DISCOVERY_PHP) },
    // Plugins and themes loaded, so a premium plugin's own updater reports its newer version.
    {
      command: "plugin_list",
      remote: wpCliLoaded("plugin", "list", "--format=json", "--fields=name,title,status,version,update,update_version,auto_update"),
    },
    {
      command: "theme_list",
      remote: wpCliLoaded("theme", "list", "--format=json", "--fields=name,title,status,version,update,update_version,auto_update"),
    },
    { command: "content_directories", remote: wpEval(CONTENT_DIRECTORIES_PHP) },
  ];
}

export interface ContentDirectories {
  readonly plugins: string;
  readonly uploads: string;
  readonly themes: string;
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
/** One `<kind>=<absolute path>` line; the path is a plain word because a later command line carries it. */
const DIRECTORY_LINE = /^(plugins|uploads|themes)=(\/[A-Za-z0-9_./@:=+-]*)$/;

/** The folders the `content_directories` command printed, or why they could not be read. */
export function contentDirectories(output: InspectOutput): ContentDirectories | { readonly unmeasured: string } {
  if (output.code !== 0) {
    return {
      unmeasured: `could not resolve the content folders with \`${output.command_line}\`: ${firstLine(output.stderr || output.stdout)}`,
    };
  }
  const found = new Map<string, string>();
  for (const line of output.stdout.split("\n").map((each) => each.trim()).filter((each) => each !== "")) {
    const match = DIRECTORY_LINE.exec(line);
    if (match !== null) found.set(match[1] as string, (match[2] as string).replace(/\/+$/, ""));
  }
  const plugins = found.get("plugins");
  const uploads = found.get("uploads");
  const themes = found.get("themes");
  if (!plugins || !uploads || !themes) {
    return {
      unmeasured: `WordPress did not name its plugins, uploads and themes folders as plain absolute paths: ${firstLine(output.stdout || output.stderr)}`,
    };
  }
  return { plugins, uploads, themes };
}

/**
 * The folder scans, over the folders WordPress named (`content_directories`): PHP files under uploads, and plugin and
 * theme folders changed within `recentDays`. `-H` follows a folder that is itself a symbolic link.
 */
export function scanCommands(server: SiteServer, recentDays: number, directories: ContentDirectories): InspectCommandLine[] {
  const { asSiteUser } = commandBuilders(server);
  const changed = (directory: string) =>
    asSiteUser("find", "-H", directory, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-mtime", `-${Math.trunc(recentDays)}`);
  return [
    { command: "uploads_php", remote: asSiteUser("find", "-H", directories.uploads, "-type", "f", "-iname", "'*.ph*'") },
    { command: "plugin_directories", remote: changed(directories.plugins) },
    { command: "theme_directories", remote: changed(directories.themes) },
  ];
}

/** Runs the fixed commands one at a time (some hosts allow one SSH session), recording what each printed. */
export async function measureWordpressInspect(
  server: SiteServer | undefined,
  run: RunProcess,
  options: { now?: () => string; signal?: AbortSignal } = {},
): Promise<WordpressInspect> {
  const now = options.now ?? (() => new Date().toISOString());
  if (server === undefined) {
    return { status: "unmeasured", reason: "the site file names no host block; the inspection needs one" };
  }
  if (server.transport !== "ssh") {
    return {
      status: "unmeasured",
      reason: `the site's host is reached by ${server.transport}, not SSH; the inspection needs an SSH host`,
    };
  }
  let commands: InspectCommandLine[];
  let target: string;
  try {
    [target = ""] = plainWords(server.target, "target");
    commands = inspectCommands(server);
  } catch (error) {
    return { status: "unmeasured", reason: error instanceof Error ? error.message : String(error) };
  }
  const measuredAt = now();
  const outputs: InspectOutput[] = [];
  const runAll = async (lines: readonly InspectCommandLine[]): Promise<string | undefined> => {
    for (const { command, remote } of lines) {
      options.signal?.throwIfAborted();
      const result = await run("ssh", [...SSH_OPTIONS, target, remote], options.signal);
      if (outputs.length === 0 && result.code === SSH_FAILED) {
        return `ssh ${target}: ${result.stderr.trim().split("\n")[0] ?? ""}`;
      }
      outputs.push({ command, command_line: remote, code: result.code, stdout: result.stdout, stderr: result.stderr });
    }
    return undefined;
  };
  const sshFailure = await runAll(commands);
  if (sshFailure !== undefined) return { status: "unmeasured", reason: sshFailure };
  // The folder scans wait for WordPress to name its folders; when it cannot, they never run and their checks are
  // unmeasured with the reason, rather than scanning a folder that may not be the site's.
  const resolved = outputs.find((output) => output.command === "content_directories");
  const directories = resolved === undefined ? undefined : contentDirectories(resolved);
  if (directories !== undefined && !("unmeasured" in directories)) {
    await runAll(scanCommands(server, RECENT_DAYS, directories));
  }
  return { status: "measured", measured_at: measuredAt, recent_days: RECENT_DAYS, outputs };
}
