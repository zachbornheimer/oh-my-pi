import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ScanRecord, ScanScope } from "./reap_scan.mjs";
import { SCANNER_SOURCE } from "./scanner_source.js";

/**
 * The machine-level agents, one per scan scope. Each runs the installed scanner on its own clock; nothing here stays
 * resident, and nothing depends on an omp session, a terminal, or a gateway being up.
 */
export interface ReaperAgent {
  /** launchd label, and the plist file name. */
  readonly label: string;
  /** Which pass the agent runs. */
  readonly scope: ScanScope;
  /**
   * Seconds between passes. Long checks are the ones that pile up on a loaded host, so they are
   * swept more often than the passes that only ever see a process whose owner already died.
   */
  readonly intervalSeconds: number;
}

export const REAPER_AGENTS: readonly ReaperAgent[] = [
  { label: "local.host.reap-long-checks", scope: "long", intervalSeconds: 120 },
  { label: "local.host.reap-orphan-checks", scope: "orphans", intervalSeconds: 300 },
  { label: "local.host.reap-omp-orphans", scope: "omp-orphans", intervalSeconds: 300 },
];

export interface AgentReport {
  label: string;
  scope: ScanScope;
  interval_seconds: number;
  plist: string;
  loaded: boolean;
  plist_written: boolean;
  last_exit_status: number | null;
  last_run_at: string | null;
  last_candidates: number | null;
}

export interface LaunchctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
/** Runs `launchctl` with these arguments. Tests substitute a fake; the real one never uses a shell. */
export type Launchctl = (args: readonly string[]) => Promise<LaunchctlResult>;

/** Where everything lives. Every field has a real default; a test passes a temporary directory for each. */
export interface AgentHost {
  /** The user LaunchAgent domain: `~/Library/LaunchAgents`. */
  agentsDir: string;
  /** The run log and its lock: `~/Library/Logs/omp`. */
  logDir: string;
  /** The scanner program's text, embedded in this tool: never located through `import.meta.url`, which omp's loader virtualizes. */
  scriptText: string;
  /** The copy the plists run, outside the tool directory so moving or promoting the tool cannot orphan an agent. */
  scriptTarget: string;
  /** Absolute node binary a plist pins; throws when there is none. */
  node: () => string;
  launchctl: Launchctl;
  uid: number;
  home: string;
}

export const SCRIPT_NAME = "reap-stale-checks.mjs";

export function defaultHost(): AgentHost {
  const home = homedir();
  return {
    agentsDir: join(home, "Library", "LaunchAgents"),
    logDir: join(home, "Library", "Logs", "omp"),
    scriptText: SCANNER_SOURCE,
    scriptTarget: join(home, ".omp", "agent", "reap-stale-checks", SCRIPT_NAME),
    node: () => nodeBinary({ home }),
    launchctl: realLaunchctl,
    uid: process.getuid?.() ?? 501,
    home,
  };
}

export function runLogPath(host: Pick<AgentHost, "logDir">): string {
  return join(host.logDir, "reap-stale-checks.jsonl");
}

function plistPath(label: string, agentsDir: string): string {
  return join(agentsDir, `${label}.plist`);
}

/** Numeric-aware descending order of version directory names (`v20.1.0` before `v9.0.0`). */
function newestFirst(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * The concrete node binary a plist pins. launchd runs with a minimal PATH and no mise shims, so a shim path would
 * work only by accident; the resolved install is what the plist names. Throws when none exists: the one thing it must
 * never return is `process.execPath` when that is not node (inside omp it is the omp binary, which a plist would then
 * launch with the scanner as an argument every few minutes).
 */
export function nodeBinary(
  options: { execPath?: string; home?: string; systemNodes?: readonly string[] } = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const home = options.home ?? homedir();
  if (/\/node$/.test(execPath) && existsSync(execPath)) return realpathSync(execPath);
  const installed = join(home, ".local/share/mise/installs/node");
  if (existsSync(installed)) {
    for (const version of newestFirst(readdirSync(installed))) {
      const candidate = join(installed, version, "bin", "node");
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of options.systemNodes ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no node binary found (mise install, /opt/homebrew/bin/node, /usr/local/bin/node): the LaunchAgents need one");
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** The plist text for one agent: node, the installed scanner, that agent's scope, and its clock. */
export function plistFor(
  agent: ReaperAgent,
  options: { node: string; script: string; logDir: string; home: string },
): string {
  const argv = [options.node, options.script, "--scope", agent.scope, "--apply", "--quiet"];
  const path = ["/opt/homebrew/bin", join(options.home, ".local/share/mise/shims"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .join(":");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${xml(agent.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>`,
    `  <key>WorkingDirectory</key><string>${xml(dirname(options.script))}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key><string>${xml(path)}</string>`,
    `    <key>HOME</key><string>${xml(options.home)}</string>`,
    `  </dict>`,
    `  <key>StartInterval</key><integer>${agent.intervalSeconds}</integer>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>ProcessType</key><string>Background</string>`,
    `  <key>LowPriorityIO</key><true/>`,
    `  <key>Nice</key><integer>10</integer>`,
    `  <key>StandardOutPath</key><string>${xml(join(options.logDir, `${agent.label}.log`))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(join(options.logDir, `${agent.label}.log`))}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** Runs one `launchctl` command against a domain-qualified target or a plist path. */
export const realLaunchctl: Launchctl = (args) => {
  const { promise, resolve } = Promise.withResolvers<LaunchctlResult>();
  execFile("/bin/launchctl", [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) });
  });
  return promise;
};

function domainTarget(host: AgentHost, label: string): string {
  return `gui/${host.uid}/${label}`;
}

/** The last line this agent's scope wrote to the run log: what the last pass that acted found and killed. */
export async function lastRun(host: AgentHost, scope: ScanScope): Promise<{ at: string | null; candidates: number | null }> {
  const text = await readFile(runLogPath(host), "utf8").catch(() => "");
  const lines = text.trim().split("\n").filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]!) as Partial<ScanRecord>;
      if (record.scope === scope) return { at: record.at ?? null, candidates: record.candidates?.length ?? null };
    } catch {
      // A torn line from a killed pass: keep walking back.
    }
  }
  return { at: null, candidates: null };
}

/** Whether launchd has the label loaded, and the exit status of its last run (`null` when it never ran). */
async function launchdState(host: AgentHost, label: string): Promise<{ loaded: boolean; lastExitStatus: number | null }> {
  const listed = await host.launchctl(["list", label]);
  if (!listed.ok) return { loaded: false, lastExitStatus: null };
  const status = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(listed.stdout) ?? /LastExitStatus\s*=\s*(-?\d+)/.exec(listed.stdout);
  return { loaded: true, lastExitStatus: status === null ? null : Number(status[1]) };
}

/** Write, load, and report one agent; a reinstall unloads first so the new plist is the one running. */
async function installOne(host: AgentHost, agent: ReaperAgent, node: string): Promise<AgentReport> {
  const path = plistPath(agent.label, host.agentsDir);
  await writeFile(
    path,
    plistFor(agent, { node, script: host.scriptTarget, logDir: host.logDir, home: host.home }),
    "utf8",
  );
  await chmod(path, 0o644);
  await host.launchctl(["unload", path]);
  await host.launchctl(["bootout", domainTarget(host, agent.label)]);
  const loaded = await host.launchctl(["load", path]);
  if (!loaded.ok) {
    throw new Error(`launchctl load ${path} failed: ${loaded.stderr.trim() || "unknown error"}`);
  }
  // `RunAtLoad` already started a pass, so the install itself proves the script runs; a `kickstart -k`
  // here would SIGTERM that pass and leave the label reporting -15 as if it had crashed.
  const state = await launchdState(host, agent.label);
  const run = await lastRun(host, agent.scope);
  return {
    label: agent.label,
    scope: agent.scope,
    interval_seconds: agent.intervalSeconds,
    plist: path,
    loaded: state.loaded,
    plist_written: true,
    last_exit_status: state.lastExitStatus,
    last_run_at: run.at,
    last_candidates: run.candidates,
  };
}

/** Copy the scanner to its stable location, then install each agent in `agents`. Resolves the node binary first so a missing node writes nothing. */
export async function installAgents(host: AgentHost, agents: readonly ReaperAgent[]): Promise<AgentReport[]> {
  const node = host.node();
  await mkdir(host.agentsDir, { recursive: true });
  await mkdir(host.logDir, { recursive: true });
  await mkdir(dirname(host.scriptTarget), { recursive: true });
  await writeFile(host.scriptTarget, host.scriptText, "utf8");
  await chmod(host.scriptTarget, 0o755);
  const reports: AgentReport[] = [];
  for (const agent of agents) reports.push(await installOne(host, agent, node));
  return reports;
}

/** Unload and delete the plists. A missing agent is already uninstalled, not an error. The scanner copy stays: other agents may use it. */
export async function uninstallAgents(host: AgentHost, agents: readonly ReaperAgent[]): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];
  for (const agent of agents) {
    const path = plistPath(agent.label, host.agentsDir);
    await host.launchctl(["bootout", domainTarget(host, agent.label)]);
    await host.launchctl(["unload", path]);
    await rm(path, { force: true });
    const run = await lastRun(host, agent.scope);
    reports.push({
      label: agent.label,
      scope: agent.scope,
      interval_seconds: agent.intervalSeconds,
      plist: path,
      loaded: false,
      plist_written: false,
      last_exit_status: null,
      last_run_at: run.at,
      last_candidates: run.candidates,
    });
  }
  return reports;
}

/** Current launchd state of the agents, plus the last logged pass each. */
export async function agentStatus(host: AgentHost, agents: readonly ReaperAgent[]): Promise<AgentReport[]> {
  const names = await readdir(host.agentsDir).catch(() => [] as string[]);
  const reports: AgentReport[] = [];
  for (const agent of agents) {
    const state = await launchdState(host, agent.label);
    const run = await lastRun(host, agent.scope);
    reports.push({
      label: agent.label,
      scope: agent.scope,
      interval_seconds: agent.intervalSeconds,
      plist: plistPath(agent.label, host.agentsDir),
      loaded: state.loaded,
      plist_written: names.includes(`${agent.label}.plist`),
      last_exit_status: state.lastExitStatus,
      last_run_at: run.at,
      last_candidates: run.candidates,
    });
  }
  return reports;
}

/** The agents a `scope` input selects: `both` is every agent. */
export function agentsFor(scope: ScanScope | "both"): readonly ReaperAgent[] {
  return scope === "both" ? REAPER_AGENTS : REAPER_AGENTS.filter((agent) => agent.scope === scope);
}
