/**
 * Builders the `host_bottlenecks` tests share: a host snapshot from a list of processes, and a scripted machine that
 * answers commands from a table. Not a test file: `bun test` only collects `*.test.ts`.
 */
import type { HostMachine } from "./gather.ts";
import type { HostSnapshot, ProcessSample } from "./types.ts";

export interface ProcessSpec {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpu: number;
  readonly rss_mb: number;
  readonly age_s: number;
}

export const proc = (pid: number, ppid: number, command: string, cpu = 0, rss_mb = 10, age_s = 600): ProcessSpec => ({
  pid,
  ppid,
  command,
  cpu,
  rss_mb,
  age_s,
});

export interface SnapshotSpec {
  readonly processes: readonly ProcessSpec[];
  readonly ncpu?: number;
  readonly avg1?: number;
  readonly uptime_s?: number;
  readonly swap?: HostSnapshot["swap"];
  readonly disks?: HostSnapshot["disks"];
  readonly vms?: HostSnapshot["vms"];
  readonly cwd?: Record<string, string>;
  readonly repo?: Record<string, string>;
  readonly hook_config?: Record<string, string>;
}

/** A snapshot of a host with `spec.processes`, an idle quad-core by default, and launchd as pid 1. */
export function snapshotOf(spec: SnapshotSpec): HostSnapshot {
  const processes: ProcessSample[] = [proc(1, 0, "/sbin/launchd"), ...spec.processes].map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    user: "zach",
    cpu_pct: p.cpu,
    rss_mb: p.rss_mb,
    age_s: p.age_s,
    command: p.command,
  }));
  return {
    taken_at: "2026-10-15T12:00:00.000Z",
    ncpu: spec.ncpu ?? 4,
    uptime_s: spec.uptime_s ?? 86400,
    load: { avg1: spec.avg1 ?? 0.5, avg5: 0.5, avg15: 0.5 },
    memory_pressure: "System-wide memory free percentage: 60%",
    ...(spec.swap === undefined ? {} : { swap: spec.swap }),
    disks: spec.disks ? [...spec.disks] : [],
    vms: spec.vms ? [...spec.vms] : [],
    processes,
    cwd: spec.cwd ?? {},
    repo: spec.repo ?? {},
    hook_config: spec.hook_config ?? {},
  };
}

export interface FakeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const ok = (stdout: string): FakeResult => ({ code: 0, stdout, stderr: "" });

export interface FakeWorld {
  readonly homeDirectory?: string;
  /** Results by command line, such as `git -C /r rev-parse --show-toplevel`. An unlisted command fails with exit 127. */
  readonly commands?: Readonly<Record<string, FakeResult>>;
  readonly files?: Readonly<Record<string, string>>;
}

/** A scripted machine: answers from `world`, records every command line, and serves the two `ps` samples in turn. */
export class FakeMachine implements HostMachine {
  readonly runs: string[] = [];
  readonly homeDirectory: string;
  private readonly samples: string[];

  constructor(private readonly world: FakeWorld = {}, samples: readonly string[] = []) {
    this.homeDirectory = world.homeDirectory ?? "/home/zach";
    this.samples = [...samples];
  }

  async run(command: string, args: readonly string[]): Promise<FakeResult> {
    const line = [command, ...args].join(" ");
    this.runs.push(line);
    if (command === "ps" && this.samples.length > 0) return ok(this.samples.length > 1 ? this.samples.shift()! : this.samples[0]!);
    return this.world.commands?.[line] ?? { code: 127, stdout: "", stderr: `no fake for ${line}` };
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.world.files?.[path];
  }

  async isFile(path: string): Promise<boolean> {
    return this.world.files?.[path] !== undefined;
  }
}
