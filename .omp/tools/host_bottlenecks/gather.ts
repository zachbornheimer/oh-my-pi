import { kindOf } from "./process_command.ts";
import type { Disk, HostSnapshot, ProcessSample, Swap, Vm, VmContainer } from "./types.ts";

/** What the gatherer needs from the machine; production binds it to `pi.exec` and the real home. Reads never throw. */
export interface HostMachine {
  readonly homeDirectory: string;
  /** Runs `command` with an argument list (no shell). Never throws for a non-zero exit; `code` is -1 when it could not start or was killed. */
  run(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  /** The file's text, or undefined when it is missing or unreadable. */
  readTextFile(path: string): Promise<string | undefined>;
  isFile(path: string): Promise<boolean>;
}

const PS_COLUMNS = "pid,ppid,pcpu,rss,etime,cputime,user,command";
const PS_ARGS = ["-axo", PS_COLUMNS] as const;
const HOOK_CONFIG_FILES: readonly string[] = ["hk.pkl", "lefthook.yml", ".hk.yaml"];
const BYTES_PER_MB = 1024;
const MS_PER_S = 1000;
const MEMORY_PRESSURE_MARKER = "free percentage";
const MEMORY_PRESSURE_UNAVAILABLE = "unavailable";
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

/** Time and waiting, so the gatherer can be run without either. */
export interface HostClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: HostClock = {
  now: () => new Date(),
  sleep: (ms) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/** What one `ps` row says; CPU is the process's lifetime average until a second sample gives the window's. */
interface Row {
  readonly sample: ProcessSample;
  readonly cpu_s: number;
}

/** Seconds in `[[dd-]hh:]mm:ss[.cc]` or `mm:ss.cc`, as `ps` prints `etime` and `cputime`; the fraction is decimal. */
export function secondsOf(clock: string): number {
  const [days, rest] = clock.includes("-") ? clock.split("-") as [string, string] : ["0", clock];
  const parts = rest.split(":");
  const last = parts.pop() ?? "0";
  const [wholeSeconds, fraction = ""] = last.split(".");
  const whole = [...parts, wholeSeconds].map(Number).reduce((total, part) => total * 60 + part, 0);
  return Number(days) * 86400 + whole + Number(fraction === "" ? "0" : `0.${fraction}`);
}

async function succeeded(machine: HostMachine, command: string, args: readonly string[]): Promise<string> {
  const result = await machine.run(command, args);
  if (result.code !== 0) {
    throw new Error(`\`${[command, ...args].join(" ")}\` failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function rowsOf(output: string): Row[] {
  const rows: Row[] = [];
  for (const line of output.split("\n")) {
    const match = PS_ROW.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pcpu, rss, etime, cputime, user, command] = match as unknown as string[];
    if (command!.startsWith(`ps ${PS_ARGS.join(" ")}`)) continue;
    rows.push({
      cpu_s: secondsOf(cputime!),
      sample: {
        pid: Number(pid),
        ppid: Number(ppid),
        user: user!,
        cpu_pct: Number(pcpu),
        rss_mb: Math.round((Number(rss) / BYTES_PER_MB) * 10) / 10,
        age_s: Math.round(secondsOf(etime!)),
        command: command!,
      },
    });
  }
  return rows;
}

/** The second sample, with CPU over the interval for every pid the first sample also saw. */
function withIntervalCpu(first: readonly Row[], second: readonly Row[], interval_s: number): ProcessSample[] {
  const before = new Map(first.map((row) => [row.sample.pid, row.cpu_s]));
  return second.map(({ sample, cpu_s }) => {
    const earlier = before.get(sample.pid);
    if (earlier === undefined || cpu_s < earlier) return sample;
    return { ...sample, cpu_pct: Math.round(((cpu_s - earlier) / interval_s) * 1000) / 10 };
  });
}

function loadAverages(output: string): HostSnapshot["load"] {
  const [avg1, avg5, avg15] = output.replace(/[{}]/g, "").trim().split(/\s+/).map(Number);
  if (avg1 === undefined || avg5 === undefined || avg15 === undefined || [avg1, avg5, avg15].some(Number.isNaN)) {
    throw new Error(`\`sysctl -n vm.loadavg\` printed ${JSON.stringify(output.trim())}, not { a b c }`);
  }
  return { avg1, avg5, avg15 };
}

function uptimeOf(bootTime: string, now: Date): number | undefined {
  const boot = /sec\s*=\s*(\d+)/.exec(bootTime)?.[1];
  return boot === undefined ? undefined : Math.max(0, Math.floor(now.getTime() / MS_PER_S) - Number(boot));
}

async function memoryPressure(machine: HostMachine): Promise<string> {
  const result = await machine.run("memory_pressure", []);
  if (result.code !== 0) return MEMORY_PRESSURE_UNAVAILABLE;
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  return (lines.find((line) => line.toLowerCase().includes(MEMORY_PRESSURE_MARKER)) ?? lines[0]
    ?? MEMORY_PRESSURE_UNAVAILABLE).trim();
}

const SWAP_LINE = /total\s*=\s*([\d.]+)([MG])B?\s*used\s*=\s*([\d.]+)([MG])B?\s*free\s*=\s*([\d.]+)([MG])/;
const MIB_PER_GB = 1024;

/** Swap as `sysctl vm.swapusage` reports it; undefined when the machine has none or reports it unreadably. */
export function swapOf(output: string): Swap | undefined {
  const match = SWAP_LINE.exec(output);
  if (match === null) return undefined;
  const [, total, totalUnit, used, usedUnit, free, freeUnit] = match as unknown as string[];
  const mb = (value: string, unit: string): number => Number(value) * (unit === "G" ? MIB_PER_GB : 1);
  return { total_mb: mb(total!, totalUnit!), used_mb: mb(used!, usedUnit!), free_mb: mb(free!, freeUnit!) };
}

async function swapUsage(machine: HostMachine): Promise<Swap | undefined> {
  const result = await machine.run("sysctl", ["-n", "vm.swapusage"]);
  return result.code === 0 ? swapOf(result.stdout) : undefined;
}

const KIB_PER_GB = 1024 * 1024;
const DF_COLUMNS = 6;
const DF_CAPACITY_COLUMN = 4;

/** One row of `df -k`, as gigabytes and a used percentage. macOS and Linux both put capacity in the fifth column. */
export function diskRow(line: string): Disk | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length < DF_COLUMNS) return undefined;
  const [, blocks, used, free, capacity] = fields as unknown as [string, string, string, string, string];
  const capacity_pct = Number(capacity!.replace("%", ""));
  if (!Number.isFinite(capacity_pct) || !Number.isFinite(Number(blocks))) return undefined;
  const gb = (kb: string): number => Math.round((Number(kb) / KIB_PER_GB) * 10) / 10;
  return {
    mount: fields.slice(DF_CAPACITY_COLUMN + 1).join(" "),
    size_gb: gb(blocks!),
    used_gb: gb(used!),
    free_gb: gb(free!),
    capacity_pct,
  };
}

/** The mounted volumes `df` reports; empty when `df` cannot run. `-P` gives six columns on macOS and Linux alike. */
async function diskUsage(machine: HostMachine): Promise<Disk[]> {
  let result = await machine.run("df", ["-k", "-P", "/", "/System/Volumes/Data"]);
  if (result.code !== 0) result = await machine.run("df", ["-k", "-P", "/"]);
  if (result.code !== 0) return [];
  const seen = new Set<string>();
  const disks: Disk[] = [];
  for (const line of result.stdout.split("\n")) {
    const disk = diskRow(line);
    if (disk === undefined || seen.has(disk.mount)) continue;
    seen.add(disk.mount);
    disks.push(disk);
  }
  return disks.sort((a, b) => b.capacity_pct - a.capacity_pct);
}

const VM_IMAGE = /(\S+\.(?:raw|img|qcow2|iso|dmg|vdi|vhd))(?:\s|$)/i;
const DOCKER_IMAGE = /com\.docker\.docker|Docker\.app/;
const DOCKER_PRODUCT = "Docker Desktop";
const DOCKER_SETTINGS = "Library/Group Containers/group.com.docker/settings-store.json";
const ONE_DECIMAL = 10;

const round = (value: number): number => Math.round(value * ONE_DECIMAL) / ONE_DECIMAL;
const KIB_PER_MIB = 1024;
const MEM_PARSE = /([\d.]+)(KiB|MiB|GiB)/;

/** Memory usage like `235.7MiB / 15.6GiB` as megabytes; undefined when it does not parse. */
function memMbOf(usage: string): number | undefined {
  const match = MEM_PARSE.exec(usage);
  if (match === null) return undefined;
  const [, value, unit] = match as unknown as string[];
  const factor = unit === "GiB" ? KIB_PER_MIB : unit === "KiB" ? 1 / KIB_PER_MIB : 1;
  return round(Number(value) * factor);
}

/** The product a VM belongs to, from the disk image `lsof` saw it using. */
function productOf(image: string, fallback: string): string {
  if (DOCKER_IMAGE.test(image)) return DOCKER_PRODUCT;
  return image === "" ? fallback : image.split("/").pop() ?? fallback;
}

async function dockerCaps(machine: HostMachine): Promise<Vm["caps"]> {
  const text = await machine.readTextFile(`${machine.homeDirectory}/${DOCKER_SETTINGS}`);
  if (text === undefined) return undefined;
  try {
    const settings = JSON.parse(text) as { Cpus?: unknown; MemoryMiB?: unknown };
    if (typeof settings.Cpus !== "number" || typeof settings.MemoryMiB !== "number") return undefined;
    return { cpus: settings.Cpus, memory_mb: settings.MemoryMiB };
  } catch {
    return undefined;
  }
}

const DOCKER_STATS_FORMAT = "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}";
const DOCKER_PS_FORMAT = "{{.Names}}\t{{.Image}}";

/** The containers inside the Docker VM, heaviest first; undefined when `docker` does not answer. */
async function dockerContainers(machine: HostMachine): Promise<VmContainer[] | undefined> {
  const stats = await machine.run("docker", ["stats", "--no-stream", "--format", DOCKER_STATS_FORMAT]);
  const list = await machine.run("docker", ["ps", "--format", DOCKER_PS_FORMAT]);
  if (stats.code !== 0 || list.code !== 0) return undefined;
  const images = new Map(
    list.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
      const [name, image] = line.split("\t");
      return [name ?? "", image ?? ""];
    }),
  );
  const containers: VmContainer[] = [];
  for (const line of stats.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name, cpu, mem] = line.split("\t");
    const mem_mb = mem === undefined ? undefined : memMbOf(mem);
    const image = images.get(name ?? "");
    if (name === undefined || cpu === undefined || mem_mb === undefined || image === undefined) continue;
    containers.push({ name, image, cpu_pct: round(Number(cpu.replace("%", ""))), mem_mb });
  }
  return containers.sort((a, b) => b.cpu_pct - a.cpu_pct);
}

/** What one VM runs inside it: its product, and for Docker its caps and its containers. */
async function vmInterior(machine: HostMachine, process: ProcessSample): Promise<Vm> {
  const lsof = await machine.run("lsof", ["-p", String(process.pid)]);
  const image = lsof.code === 0 ? VM_IMAGE.exec(lsof.stdout)?.[1] ?? "" : "";
  const product = productOf(image, "unknown");
  const base: Vm = { pid: process.pid, product, image, cpu_pct: process.cpu_pct, rss_mb: process.rss_mb };
  if (product !== DOCKER_PRODUCT) return base;
  const caps = await dockerCaps(machine);
  const containers = await dockerContainers(machine);
  return {
    ...base,
    ...(caps === undefined ? {} : { caps }),
    ...(containers === undefined ? {} : { containers }),
  };
}

/** Every VM process of the sample, with what each runs inside; a VM the gatherer cannot see into is still listed. */
async function virtualMachines(machine: HostMachine, processes: readonly ProcessSample[]): Promise<Vm[]> {
  const roots = processes.filter((process) => process.pid !== 1 && kindOf(process.command) === "vm");
  return Promise.all(roots.map((process) => vmInterior(machine, process)));
}

type SwapAndDisks = Pick<HostSnapshot, "swap" | "disks">;

/** Swap and the mounted volumes; `swap` is absent when the machine reports none. */
async function swapAndDisks(machine: HostMachine): Promise<SwapAndDisks> {
  const [swap, disks] = await Promise.all([swapUsage(machine), diskUsage(machine)]);
  return { ...(swap === undefined ? {} : { swap }), disks };
}

/** The pids worth a closer look: the `top` heaviest by CPU together with the `top` heaviest by memory. */
function examinedPids(processes: readonly ProcessSample[], top: number): number[] {
  const by = (field: "cpu_pct" | "rss_mb") => [...processes].sort((a, b) => b[field] - a[field]).slice(0, top);
  return [...new Set([...by("cpu_pct"), ...by("rss_mb")].map((process) => process.pid))];
}

async function workingDirectory(machine: HostMachine, pid: number): Promise<string | undefined> {
  const result = await machine.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
}

async function repositoryOf(machine: HostMachine, cwd: string): Promise<string | undefined> {
  const result = await machine.run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

async function hookConfigOf(machine: HostMachine, repo: string): Promise<string | undefined> {
  for (const file of HOOK_CONFIG_FILES) {
    const path = `${repo}/${file}`;
    if (await machine.isFile(path)) return path;
  }
  return undefined;
}

type Located = Pick<HostSnapshot, "cwd" | "repo" | "hook_config">;

/** Where the examined processes work: their directories, the repositories those are in, and each repository's hook file. */
async function locate(machine: HostMachine, pids: readonly number[]): Promise<Located> {
  const cwds = await Promise.all(pids.map(async (pid) => [pid, await workingDirectory(machine, pid)] as const));
  const cwd: Record<string, string> = {};
  for (const [pid, directory] of cwds) if (directory !== undefined) cwd[String(pid)] = directory;
  const directories = [...new Set(Object.values(cwd))];
  const repos = await Promise.all(directories.map(async (dir) => [dir, await repositoryOf(machine, dir)] as const));
  const repo: Record<string, string> = {};
  for (const [directory, top] of repos) if (top !== undefined) repo[directory] = top;
  const tops = [...new Set(Object.values(repo))];
  const configs = await Promise.all(tops.map(async (top) => [top, await hookConfigOf(machine, top)] as const));
  const hook_config: Record<string, string> = {};
  for (const [top, path] of configs) if (path !== undefined) hook_config[top] = path;
  return { cwd, repo, hook_config };
}

export interface SnapshotRequest {
  readonly top: number;
  readonly window_s: number;
}

/** The host as `host.bottlenecks` reads it: two process samples `window_s` apart, the load, and where the heaviest work runs. */
export async function gatherSnapshot(
  machine: HostMachine,
  { top, window_s }: SnapshotRequest,
  clock: HostClock = systemClock,
): Promise<HostSnapshot> {
  const first = rowsOf(await succeeded(machine, "ps", PS_ARGS));
  const firstAt = clock.now();
  await clock.sleep(window_s * MS_PER_S);
  const second = rowsOf(await succeeded(machine, "ps", PS_ARGS));
  const secondAt = clock.now();
  const measured = (secondAt.getTime() - firstAt.getTime()) / MS_PER_S;
  const processes = withIntervalCpu(first, second, measured > 0 ? measured : window_s);
  const ncpuText = (await succeeded(machine, "sysctl", ["-n", "hw.ncpu"])).trim();
  const ncpu = Number(ncpuText);
  if (!Number.isInteger(ncpu) || ncpu < 1) {
    throw new Error(`\`sysctl -n hw.ncpu\` printed ${JSON.stringify(ncpuText)}, not a CPU count`);
  }
  const load = loadAverages(await succeeded(machine, "sysctl", ["-n", "vm.loadavg"]));
  const uptime_s = uptimeOf(await succeeded(machine, "sysctl", ["-n", "kern.boottime"]), secondAt);
  return {
    taken_at: secondAt.toISOString(),
    ncpu,
    ...(uptime_s === undefined ? {} : { uptime_s }),
    load,
    memory_pressure: await memoryPressure(machine),
    ...(await swapAndDisks(machine)),
    vms: await virtualMachines(machine, processes),
    processes,
    ...(await locate(machine, examinedPids(processes, top))),
  };
}
