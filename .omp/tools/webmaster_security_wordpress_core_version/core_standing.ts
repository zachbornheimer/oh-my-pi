/** Where an installed WordPress version stands against the released ones. Port of Mastra's core_version helpers. */

export interface CoreStanding {
  readonly installed: string;
  readonly branch: string;
  readonly branchLatest: string;
  readonly newest: string;
  /** fail: missing its own branch's security fixes. warn: current on an older branch. */
  readonly status: "pass" | "warn" | "fail";
}

/** `6.4` for `6.4.1`. */
export const branchOf = (version: string): string => version.split(".").slice(0, 2).join(".");

/** Whether version `a` is newer than `b`, part by part. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const newestOf = (versions: readonly string[], floor: string): string =>
  versions.reduce((best, version) => (isNewer(version, best) ? version : best), floor);

export function coreStanding(installed: string, released: readonly string[]): CoreStanding {
  const branch = branchOf(installed);
  const branchLatest = newestOf(released.filter((version) => branchOf(version) === branch), installed);
  const newest = newestOf(released, installed);
  const status = isNewer(branchLatest, installed) ? "fail" : isNewer(newest, installed) ? "warn" : "pass";
  return { installed, branch, branchLatest, newest, status };
}
