import {
  type AgentHost,
  type AgentReport,
  agentStatus,
  agentsFor,
  installAgents,
  REAPER_AGENTS,
  runLogPath,
  uninstallAgents,
} from "./agents.js";
import { runScan, type ScanDeps, type ScanRecord, type ScanScope } from "./reap_scan.mjs";

export const REAP_ACTIONS = ["report", "reap", "install", "install_and_reap", "uninstall", "status"] as const;
export type ReapAction = (typeof REAP_ACTIONS)[number];
export const REAP_SCOPES = ["long", "orphans", "omp-orphans", "both"] as const;
export type ReapScope = (typeof REAP_SCOPES)[number];

export interface ReapInput {
  action?: string | null;
  scope?: string | null;
  max_age_minutes?: number | null;
}

export interface ReapOutput {
  action: ReapAction;
  scans: ScanRecord[];
  agents: AgentReport[];
  log_file: string;
}

/** What `execute` needs from the machine, replaced wholesale by a test. */
export interface ReapEnvironment {
  host: AgentHost;
  /** The scanner's seams (process table, kill, clock); undefined means the real ones. */
  scanDeps?: ScanDeps;
  signal?: AbortSignal;
}

function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`reap_stale_checks: ${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** Validates the input the way the tool's schema promises; the schema alone cannot be trusted to have run. */
export function parseInput(input: ReapInput): { action: ReapAction; scope: ReapScope; maxAgeMinutes: number | undefined } {
  const action = oneOf(input.action, REAP_ACTIONS, "report", "action");
  const scope = oneOf(input.scope, REAP_SCOPES, "both", "scope");
  const minutes = input.max_age_minutes ?? undefined;
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 720)) {
    throw new Error(`reap_stale_checks: max_age_minutes must be an integer in 1..720, got ${String(minutes)}`);
  }
  return { action, scope, maxAgeMinutes: minutes };
}

/** Runs the action. Throws when a pass could not read the process table: that is a failure, not an empty scan. */
export async function runReap(input: ReapInput, environment: ReapEnvironment): Promise<ReapOutput> {
  const { action, scope, maxAgeMinutes } = parseInput(input);
  const { host, scanDeps, signal } = environment;
  const scans: ScanRecord[] = [];
  let agents: AgentReport[] = [];

  const passes = async (apply: boolean): Promise<void> => {
    for (const agent of agentsFor(scope)) {
      signal?.throwIfAborted();
      const scan = await runScan(
        { scope: agent.scope as ScanScope, maxAgeMin: maxAgeMinutes, apply, logDir: host.logDir, signal },
        scanDeps,
      );
      if (scan.error !== undefined) throw new Error(`reap_stale_checks: ${agent.scope} pass failed: ${scan.error}`);
      scans.push(scan);
    }
  };

  switch (action) {
    case "report":
      await passes(false);
      agents = await agentStatus(host, REAPER_AGENTS);
      break;
    case "reap":
      await passes(true);
      agents = await agentStatus(host, REAPER_AGENTS);
      break;
    case "install":
      agents = await installAgents(host, agentsFor(scope));
      if (scope !== "both") agents = [...agents, ...(await agentStatus(host, REAPER_AGENTS.filter((a) => a.scope !== scope)))];
      break;
    case "install_and_reap":
      agents = await installAgents(host, agentsFor(scope));
      await passes(true);
      break;
    case "uninstall":
      agents = await uninstallAgents(host, agentsFor(scope));
      break;
    case "status":
      agents = await agentStatus(host, REAPER_AGENTS);
      break;
  }
  return { action, scans, agents, log_file: runLogPath(host) };
}

/** The model-facing rendering: one line per scan and candidate, one per agent. */
export function reapText(output: ReapOutput): string {
  const lines: string[] = [`reap_stale_checks ${output.action}`];
  for (const scan of output.scans) {
    if (scan.skipped !== undefined) {
      lines.push(`scan ${scan.scope}: skipped (${scan.skipped}); nothing scanned or killed`);
      continue;
    }
    const verb = scan.applied ? `killed ${scan.killed.length}${scan.survivors.length ? `, ${scan.survivors.length} survived` : ""}` : "would kill";
    lines.push(`scan ${scan.scope}: ${scan.candidates.length} candidate(s), ${scan.applied ? verb : `${verb} ${scan.candidates.length}`} (of ${scan.scanned} processes, older than ${scan.max_age_min} min)`);
    for (const candidate of scan.candidates) {
      lines.push(`  ${candidate.pid} ${candidate.age_min ?? "?"}m [${candidate.reason}] ${candidate.command.slice(0, 140)}`);
    }
  }
  for (const agent of output.agents) {
    lines.push(
      `agent ${agent.label} (${agent.scope}, every ${agent.interval_seconds}s): ${agent.loaded ? "loaded" : "not loaded"}, plist ${agent.plist_written ? "present" : "absent"}`
        + `, last exit ${agent.last_exit_status ?? "none"}, last run ${agent.last_run_at ?? "never"}`,
    );
  }
  lines.push(`run log: ${output.log_file}`);
  return lines.join("\n");
}
