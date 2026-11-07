import type { Disk, Family, HostBottlenecksOutput, Swap, Vm } from "./types.ts";

/** How heavy a family is on one scale: its CPU percent plus its memory in GB. */
export const weightOf = (family: Pick<Family, "cpu_pct" | "rss_mb">): number => family.cpu_pct + family.rss_mb / 1024;

const ONE_DECIMAL = 10;
const GB_PER_TB = 1024;

const gb = (value: number): number => Math.round(value * ONE_DECIMAL) / ONE_DECIMAL;

/** A size a person reads: terabytes with a decimal from 1024 GB up, gigabytes below. */
export function sizeText(gbValue: number): string {
  return gbValue >= GB_PER_TB ? `${gb(gbValue / GB_PER_TB)} TB` : `${gb(gbValue)} GB`;
}

/** The load ratio, the worst family and what to do about it, in one sentence; derived, never modelled. */
export function summaryOf(
  load: HostBottlenecksOutput["load"],
  worst: Family | undefined,
  extras: Pick<HostBottlenecksOutput, "swap" | "disks" | "vms">,
): string {
  const host = `Load ${load.ratio.toFixed(2)} per core (avg1 ${load.avg1} on ${load.ncpu} cores).`;
  const heaviest = worst === undefined
    ? "No process family is heavy enough to report."
    : `Worst: ${worst.name} (${worst.verdict}, ${worst.cpu_pct}% cpu, ${worst.rss_mb} MB); remedy ${worst.remedy ?? "none"}.`;
  return [host, heaviest, swapLine(extras.swap), diskLine(extras.disks), vmLine(extras.vms)]
    .filter((part) => part !== "")
    .join(" ");
}

/** The swap reading, when swap is in use: the part of it that tells a buyer something. */
function swapLine(swap: Swap | undefined): string {
  return swap === undefined || swap.used_mb === 0
    ? ""
    : `Swap ${sizeText(swap.used_mb / 1024)} of ${sizeText(swap.total_mb / 1024)} used.`;
}

const FULL_DISK_PCT = 90;

/** The fullest disk, named only when it is close to full: a full disk is a capacity the next machine needs. */
function diskLine(disks: readonly Disk[]): string {
  const fullest = disks[0];
  return fullest === undefined || fullest.capacity_pct < FULL_DISK_PCT
    ? ""
    : `Disk ${fullest.mount} is ${fullest.capacity_pct}% full (${sizeText(fullest.free_gb)} free of `
      + `${sizeText(fullest.size_gb)}).`;
}

/** The VM whose containers demand more cores than the VM has: the demand a process list cannot see. */
function vmLine(vms: readonly Vm[]): string {
  const worst = vms
    .filter((vm) => vm.caps !== undefined && vm.containers !== undefined && vm.containers.length > 0)
    .map((vm) => ({
      vm,
      cores: vm.containers!.reduce((total, container) => total + container.cpu_pct, 0) / 100,
    }))
    .filter(({ vm, cores }) => cores > vm.caps!.cpus)
    .sort((a, b) => b.cores - a.cores)[0];
  return worst === undefined
    ? ""
    : `${worst.vm.product} VM (pid ${worst.vm.pid}): its containers demand ${gb(worst.cores)} cores of the VM's `
      + `${worst.vm.caps!.cpus}.`;
}
