import { RangeIncludes } from "./peerrange.js";
import type { Command, Peers, Process } from "./ports.js";
import type { Ecosystem, Package } from "./schemas.js";

// Port of agentmux internal/depupgrade/units.go: upgrade units from peerDependencies edges, and the
// npm-backed Peers adapter they are computed from.

const NPM_BIN = "npm";
const UNIT_NAME_JOIN = "+";

/** Unit is one commit's worth of packages: a package plus any peer it is coupled to by a peerDependencies edge. */
export interface Unit {
  packages: Package[];
}

function names(unit: Unit): string[] {
  return unit.packages.map((pkg) => pkg.name);
}

function name(unit: Unit): string {
  return names(unit).join(UNIT_NAME_JOIN);
}

/** unitNames is every unit's package names, in the snapshot's order. */
export function unitNames(units: Unit[]): string[][] {
  return units.map(names);
}

/** unitOf is the name of the unit that holds `pkg`, or "" when none does. */
export function unitOf(units: Unit[], pkg: string): string {
  for (const unit of units) {
    for (const p of unit.packages) {
      if (p.name === pkg) return name(unit);
    }
  }
  return "";
}

function collectUnits(packages: Package[], find: (i: number) => number): Unit[] {
  const units: Unit[] = [];
  const index = new Map<number, number>();
  for (let i = 0; i < packages.length; i++) {
    const root = find(i);
    let at = index.get(root);
    if (at === undefined) {
      at = units.length;
      index.set(root, at);
      units.push({ packages: [] });
    }
    units[at]!.packages.push(packages[i]!);
  }
  return units;
}

/**
 * units groups the bumped packages. Two are one unit when one lists the other as a peer dependency whose
 * range includes the version it moves to. A package whose peers cannot be read is recorded as a gap and
 * left on its own.
 */
export async function units(
  peers: Peers,
  eco: Ecosystem,
  packages: Package[],
  record: (message: string) => void,
): Promise<Unit[]> {
  const parent = packages.map((_, i) => i);
  const find = (start: number): number => {
    let i = start;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < packages.length; i++) {
    const p = packages[i]!;
    let declared: Record<string, string>;
    try {
      declared = await peers.of(eco, p.name, p.to);
    } catch (error) {
      record(`peer dependencies of ${p.name}@${p.to} unavailable: ${(error as Error).message}`);
      continue;
    }
    for (let j = 0; j < packages.length; j++) {
      const q = packages[j]!;
      const rng = declared[q.name];
      if (rng !== undefined && i !== j && RangeIncludes(rng, q.to)) parent[find(j)] = find(i);
    }
  }
  return collectUnits(packages, find);
}

/** NPMPeers implements Peers by asking the npm registry. */
export class NPMPeers implements Peers {
  constructor(private readonly process: Process) {}

  /** Of returns the peerDependencies of pkg@version. Ecosystems without peer dependencies answer none. */
  async of(eco: Ecosystem, pkg: string, version: string): Promise<Record<string, string>> {
    if (eco !== "npm") return {};
    const spec = `${pkg}@${version}`;
    const command: Command = { command: NPM_BIN, args: ["view", spec, "peerDependencies", "--json"] };
    let result;
    try {
      result = await this.process.run(command);
    } catch (error) {
      throw new Error(`peers: npm view ${spec}: ${(error as Error).message}`, { cause: error });
    }
    if (result.code !== 0) {
      throw new Error(`peers: npm view ${spec}: exit ${result.code}: ${result.stderr.trim()}`);
    }
    const out = result.stdout.trim();
    if (out === "") return {};
    try {
      return JSON.parse(out) as Record<string, string>;
    } catch (error) {
      throw new Error(`peers: decode npm view ${spec}: ${(error as Error).message}`, { cause: error });
    }
  }
}
