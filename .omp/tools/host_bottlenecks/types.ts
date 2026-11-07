/**
 * The vocabulary of `host_bottlenecks`: the machine snapshot the gatherer reads, the families the rules judge, and the
 * verdicts and remedies they may reach. Types only, plus the closed lists the model reply is validated against.
 */

/** How many families of each kind (CPU, memory) are examined. */
export const DEFAULT_TOP = 10;
/** Seconds between the two process samples that give CPU over an interval instead of a lifetime average. */
export const DEFAULT_WINDOW_S = 5;

export const VERDICTS = ["normal", "overscoped", "runaway", "contention", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The remedies the model may pick from; it never invents a command. */
export const REMEDIES = [
  "scope_hook_to_changed_files",
  "serialize_gates",
  "cap_fan_out",
  "kill_stale",
  "restart_daemon",
  "none",
] as const;
export type Remedy = (typeof REMEDIES)[number];

export const PROCESS_KINDS = [
  "harness",
  "gate",
  "test",
  "build",
  "model_server",
  "vm",
  "mcp",
  "sync",
  "indexer",
  "system",
  "shell",
  "git",
  "other",
] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

/** One process as `ps` reported it, with CPU measured over the sample window. */
export interface ProcessSample {
  pid: number;
  /** Parent process id; used to group processes into families. */
  ppid: number;
  user: string;
  /** CPU percent over the sample window (a lifetime average when only one sample exists). */
  cpu_pct: number;
  rss_mb: number;
  /** Seconds since the process started. */
  age_s: number;
  command: string;
}

/** Swap as `sysctl vm.swapusage` reports it, in megabytes. */
export interface Swap {
  used_mb: number;
  total_mb: number;
  free_mb: number;
}

/** One mounted volume as `df` reports it, in gigabytes. */
export interface Disk {
  mount: string;
  size_gb: number;
  used_gb: number;
  free_gb: number;
  capacity_pct: number;
}

/** One container inside a VM, as `docker stats` reports it. */
export interface VmContainer {
  name: string;
  image: string;
  /** `docker stats` counts 100% as one core, so 3650 is a demand for 36.5 cores. */
  cpu_pct: number;
  mem_mb: number;
}

/** One virtual machine seen from the outside and, when the gatherer can see in, from the inside. */
export interface Vm {
  pid: number;
  /** The product the VM belongs to, read from its disk image or its command. */
  product: string;
  /** The disk image the VM runs from, as `lsof` reported it; empty when none was seen. */
  image: string;
  cpu_pct: number;
  rss_mb: number;
  /** The VM's configured resources, when the product exposes them. */
  caps?: { cpus: number; memory_mb: number };
  /** The containers inside the VM, heaviest first, when the product reports them. */
  containers?: VmContainer[];
}

/** What the gatherer read from the machine; the rules see nothing else. */
export interface HostSnapshot {
  taken_at: string;
  ncpu: number;
  /** Seconds since boot, when known. */
  uptime_s?: number;
  load: { avg1: number; avg5: number; avg15: number };
  memory_pressure: string;
  swap?: Swap;
  disks: Disk[];
  vms: Vm[];
  processes: ProcessSample[];
  /** Working directory keyed by pid, for the processes the gatherer looked at. */
  cwd: Record<string, string>;
  /** Git top-level directory keyed by cwd, when the cwd is inside a repository. */
  repo: Record<string, string>;
  /** The hook configuration file (hk.pkl, lefthook.yml, .hk.yaml) keyed by repository, when one exists. */
  hook_config: Record<string, string>;
}

export interface Family {
  /** The command the family is known by: its root's base name, plus the dominant child's when that differs. */
  name: string;
  root_pid: number;
  pids: number[];
  count: number;
  cpu_pct: number;
  rss_mb: number;
  age_s: number;
  kind: ProcessKind;
  /** The root's ancestors as command base names, nearest first. */
  ancestry: string[];
  /** What started the work, read from the ancestry: `git commit`, `git push`, a harness session, launchd. */
  trigger?: string;
  repo?: string;
  hook_phase?: string;
  scope?: { invoked_files?: number; whole_tree?: boolean };
  verdict: Verdict;
  confidence: number;
  evidence: string[];
  remedy?: Remedy;
  /** The one sentence a person acts on, with the exact command when one applies; never executed. */
  advice?: string;
}

export interface HostBottlenecksOutput {
  taken_at: string;
  load: {
    avg1: number;
    avg5: number;
    avg15: number;
    ncpu: number;
    /** avg1 over ncpu: above 1 the machine is oversubscribed. */
    ratio: number;
    memory_pressure: string;
  };
  /** The heaviest families that are not normal, worst first (normal ones too when `include_normal`). */
  families: Family[];
  /** The heaviest families judged normal, kept so the picture is complete. */
  normal: Family[];
  swap?: Swap;
  /** The mounted volumes, fullest capacity first. */
  disks: Disk[];
  vms: Vm[];
  summary: string;
}

/** What the model answers for one family the rules left `unknown`. */
export interface ModelVerdict {
  root_pid: number;
  verdict: Verdict;
  remedy: Remedy;
  advice: string;
  confidence: number;
}
