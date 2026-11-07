import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileSiteLock, localExclusive, localProcess } from "./lock";
import {
  type ApplyPort,
  type DigestPort,
  type JobName,
  type MaintainSite,
  type NotifierPort,
  type NotifyDecisionStep,
  type DiagnoseCapabilities,
  type RunRecord,
  type SchedulePorts,
  type SiteRef,
  type SitesPort,
  type SnapshotPort,
  TIERS,
  type Tier,
} from "./types";

export const SITES_DIRECTORY_ENVIRONMENT = "WEBMASTER_SITES_DIR";
export const STATE_DIRECTORY_ENVIRONMENT = "WEBMASTER_STATE_DIR";
const SITES_DIRECTORY_UNDER_HOME = "Developer/Zysys/webmaster/sites";
const PROFILE_SUFFIX = ".yaml";
const SITE_NAME = /^[a-z0-9-]+$/;
const NOTIFY_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;

const codeOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The profile directory: `WEBMASTER_SITES_DIR`, else `~/Developer/Zysys/webmaster/sites`. */
export function sitesDirectory(env: Env = process.env, home: string = homedir()): string {
  const set = env[SITES_DIRECTORY_ENVIRONMENT];
  return set !== undefined && set !== "" ? set : join(home, SITES_DIRECTORY_UNDER_HOME);
}

/** The webmaster state: `WEBMASTER_STATE_DIR`, else `$XDG_STATE_HOME/webmaster`, else `~/.local/state/webmaster`. */
export function stateDirectory(env: Env = process.env, home: string = homedir()): string {
  const set = env[STATE_DIRECTORY_ENVIRONMENT];
  if (set !== undefined && set !== "") return set;
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "state"), "webmaster");
}

/**
 * `webmaster sites`: profile names (one `<name>.yaml` per site) with tiers. A profile that cannot be read, is not a
 * mapping or has no valid `tier` is listed with `tier: null` and the problem. Only the tier is validated here (the
 * source validated the whole Mastra `SiteProfile`); a missing directory lists no sites.
 */
export function profileSites(directory: string): SitesPort {
  return {
    async list() {
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
      const names = files
        .filter((file) => file.endsWith(PROFILE_SUFFIX))
        .map((file) => file.slice(0, -PROFILE_SUFFIX.length))
        .filter((name) => SITE_NAME.test(name))
        .sort();
      return Promise.all(names.map((name) => readProfile(directory, name)));
    },
  };
}

async function readProfile(directory: string, name: string): Promise<SiteRef> {
  const path = join(directory, `${name}${PROFILE_SUFFIX}`);
  try {
    const parsed: unknown = Bun.YAML.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a mapping`);
    const tier = (parsed as Record<string, unknown>)["tier"];
    if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) {
      throw new Error(`${path}: tier must be one of ${TIERS.join(", ")}`);
    }
    return { name, tier: tier as Tier };
  } catch (error) {
    return { name, tier: null, problem: `profile unreadable: ${reasonOf(error)}` };
  }
}

/** Saved report snapshots: `<stateDir>/<site>/*.json`, full paths; a site with no directory has none. */
export function directorySnapshots(stateDir: string): SnapshotPort {
  return {
    async list(site) {
      if (!SITE_NAME.test(site)) throw new Error(`snapshots refused: ${JSON.stringify(site)} is not a profile name`);
      try {
        return (await readdir(join(stateDir, site))).filter((name) => name.endsWith(".json")).map((name) => join(stateDir, site, name));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
    },
  };
}

/** Run state under `<stateDir>/schedule`: `<job>.last.json` replaced atomically, finished runs appended to `<job>.runs.jsonl`. */
export function fileRunState(stateDir: string): SchedulePorts["state"] {
  const directory = join(stateDir, "schedule");
  return {
    async save(record: RunRecord) {
      const line = `${JSON.stringify(record)}\n`;
      await mkdir(directory, { recursive: true });
      const last = join(directory, `${record.job}.last.json`);
      const staging = `${last}.${process.pid}.tmp`;
      await writeFile(staging, line, "utf8");
      await rename(staging, last);
      if (record.finishedAt !== null) await appendFile(join(directory, `${record.job}.runs.jsonl`), line, "utf8");
    },
  };
}

/** The weekly reminder points at `<stateDir>/reports/isjac.html` when the digest left one. */
export function reportReminder(stateDir: string): SchedulePorts["reminder"] {
  return {
    async readyReport() {
      const html = join(stateDir, "reports", "isjac.html");
      try {
        return (await stat(html)).isFile() ? html : undefined;
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}

type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * macOS desktop notification through `osascript`. The message is passed as an argument of the script, never spliced
 * into its text, so a message cannot inject script. Any other platform is refused with an error.
 */
export function osascriptNotifier(exec: Exec, platform: string = process.platform, signal?: AbortSignal): NotifierPort {
  return {
    async send(message) {
      if (platform !== "darwin") {
        throw new Error(`desktop notification is only supported on macOS (darwin); this platform is ${platform}`);
      }
      signal?.throwIfAborted();
      const result = await exec(
        "osascript",
        ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "Webmaster"', "-e", "end run", message],
        { timeout: NOTIFY_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`osascript was killed after ${NOTIFY_TIMEOUT_MS / 1000} s`);
      }
      if (result.code !== 0) throw new Error(`osascript exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    },
  };
}

/** Facilities a native tool cannot provide; the live default for each port that needs one says which. */
export const BLOCKED = {
  diagnose:
    "BLOCKED: the profiled diagnose workflow and the report snapshot history store (Mastra `diagnose` workflow with `webmaster-site` capability checks) are not available natively",
  maintain:
    "BLOCKED: the site-maintain workflow (site audit, Linear/atask filing and the fix agent, run by the Mastra `siteMaintain` workflow) is not available natively",
  notifyDecision:
    "BLOCKED: the notify-decision workflow and its alert log (`<stateDir>/notify`, driven by the Mastra `notifyDecision` workflow over a saved report) are not available natively",
} as const;

export const diagnoseBlocked: DiagnoseCapabilities = () => Promise.reject(new Error(BLOCKED.diagnose));
export const maintainBlocked: MaintainSite = () => Promise.reject(new Error(BLOCKED.maintain));
export const notifyDecisionBlocked: NotifyDecisionStep = () => Promise.reject(new Error(BLOCKED.notifyDecision));
/** The source's own answer for an unbound digest (the siteReport workflow) and apply (the siteApply workflow) port. */
export const digestNotWired: DigestPort = () => Promise.resolve({ status: "not wired" });
export const applyNotWired: ApplyPort = () => Promise.resolve({ status: "not wired" });

export interface LiveOptions {
  exec: Exec;
  env?: Env;
  home?: string;
  platform?: string;
  signal?: AbortSignal;
}

/** The live ports: real files and `osascript`, and an explicit BLOCKED answer for each Mastra-only workflow. */
export function livePorts(options: LiveOptions): SchedulePorts {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const stateDir = stateDirectory(env, home);
  const scheduleDir = join(stateDir, "schedule");
  return {
    sites: profileSites(sitesDirectory(env, home)),
    diagnose: diagnoseBlocked,
    maintain: maintainBlocked,
    snapshots: directorySnapshots(stateDir),
    notifyDecision: notifyDecisionBlocked,
    notifier: osascriptNotifier(options.exec, options.platform, options.signal),
    digest: digestNotWired,
    apply: applyNotWired,
    reminder: reportReminder(stateDir),
    state: fileRunState(stateDir),
    // One lock file per job and site: a second `weekly` for isjac is refused, an `uptime` is not.
    lockFor: (job: JobName) => fileSiteLock(localExclusive, scheduleDir, `webmaster schedule ${job}`, `schedule-${job}`, localProcess),
    now: () => new Date(),
  };
}
