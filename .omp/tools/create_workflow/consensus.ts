import type { Leaf, Member, Merged, Rejected } from "./types.js";

/** A capability the samples agree on: one concept, however each sample named it. */
export interface AgreedLeaf extends Leaf {
  /** How many different samples proposed it. */
  readonly agreement: number;
  readonly members: readonly Member[];
  /** Set when the confirming model gave it a better name. */
  readonly renamed_from?: string;
}

export interface Agreement {
  readonly kept: AgreedLeaf[];
  readonly merged: Merged[];
  readonly rejected: Rejected[];
}

/** The agreement a run asks for: `minAgreement`, never more than the samples there are. */
export const requiredAgreement = (minAgreement: number, samples: number): number => Math.min(minAgreement, samples);

/** How many different samples a cluster's members come from. */
export const agreementOf = (members: readonly Member[]): number => new Set(members.map((member) => member.sample)).size;

/**
 * Keeps the clusters that at least `needed` samples proposed. The rest go to `rejected` under their canonical name,
 * with the members that made them, so what the samples said is not lost. A kept cluster reports each member that
 * had another name as merged into it.
 */
export function partitionByAgreement(
  clusters: readonly AgreedLeaf[],
  needed: number,
  samples: number,
): Agreement {
  const kept: AgreedLeaf[] = [];
  const merged: Merged[] = [];
  const rejected: Rejected[] = [];
  for (const cluster of clusters) {
    if (cluster.agreement >= needed) {
      kept.push(cluster);
      const folded = new Set(cluster.members.map((member) => member.name).filter((name) => name !== cluster.name));
      merged.push(...[...folded].map((name) => ({ name, into: cluster.name })));
    } else {
      rejected.push({
        name: cluster.name,
        objection: `proposed by ${cluster.agreement} of ${samples} samples`,
        failed_criteria: [],
        agreement: cluster.agreement,
        members: cluster.members,
      });
    }
  }
  return { kept, merged, rejected };
}
