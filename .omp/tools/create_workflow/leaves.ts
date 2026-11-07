import type { ProposedCapability, SourceRun } from "./types.js";

/** A leaf with the source that proposed it. */
export interface LeafOfSource {
  readonly source: string;
  readonly leaf: ProposedCapability;
}

/** A leaf proposed again by a later source: listed where it was proposed again, planned once, at the first source. */
export interface Duplicate {
  readonly name: string;
  readonly source: string;
  readonly first_source: string;
}

/** What implement_code is asked to build: the leaf as a design object. */
export interface DesignObject {
  readonly name: string;
  readonly purpose: string;
  readonly input_summary: string;
  readonly output_summary: string;
  readonly pseudocode: string;
}

/** Optional hints about where the built code belongs and in what language (implement_code's `hints`). */
export interface Hints {
  readonly near?: string;
  readonly language?: string;
}

/** The arguments of one `implement_code` call. */
export interface ImplementRequest {
  readonly design: DesignObject;
  readonly repo: string;
  readonly hints?: Hints;
}

export interface PlannedLeaf {
  readonly source: string;
  readonly name: string;
  readonly request: ImplementRequest;
}

export type UnplannedReason = "beyond max_leaves" | "no pseudocode: the proposal was phase 1 or phase 2 wrote none for this leaf";

export interface UnplannedLeaf {
  readonly source: string;
  readonly name: string;
  readonly reason: UnplannedReason;
}

/**
 * The leaves to plan and the repeats left out: a name proposed by an earlier source (or run) is planned there only.
 * With `maxLeaves`, only that many of them, in run order.
 */
export function leavesToBuild(
  runs: readonly SourceRun[],
  maxLeaves?: number,
): { build: LeafOfSource[]; beyond: LeafOfSource[]; duplicates: Duplicate[] } {
  const firstSourceOf = new Map<string, string>();
  const unique: LeafOfSource[] = [];
  const duplicates: Duplicate[] = [];
  for (const run of runs) {
    for (const leaf of run.capabilities) {
      const first = firstSourceOf.get(leaf.name);
      if (first === undefined) {
        firstSourceOf.set(leaf.name, run.source);
        unique.push({ source: run.source, leaf });
      } else {
        duplicates.push({ name: leaf.name, source: run.source, first_source: first });
      }
    }
  }
  return { build: unique.slice(0, maxLeaves), beyond: maxLeaves === undefined ? [] : unique.slice(maxLeaves), duplicates };
}

/** The leaf as implement_code's design, or undefined when phase 2 wrote no pseudocode for it. */
export function designOf(leaf: ProposedCapability): DesignObject | undefined {
  if (leaf.pseudocode === undefined) return undefined;
  return {
    name: leaf.name,
    purpose: leaf.purpose,
    input_summary: leaf.input_summary,
    output_summary: leaf.output_summary,
    pseudocode: leaf.pseudocode,
  };
}

/** The implement_code request for every chosen leaf that has pseudocode; the others are reported as unplanned, never dropped. */
export function plan(
  chosen: readonly LeafOfSource[],
  beyond: readonly LeafOfSource[],
  repo: string,
  hints: Hints | undefined,
): { planned: PlannedLeaf[]; unplanned: UnplannedLeaf[] } {
  const planned: PlannedLeaf[] = [];
  const unplanned: UnplannedLeaf[] = [];
  for (const { source, leaf } of chosen) {
    const design = designOf(leaf);
    if (design === undefined) {
      unplanned.push({ source, name: leaf.name, reason: "no pseudocode: the proposal was phase 1 or phase 2 wrote none for this leaf" });
      continue;
    }
    planned.push({ source, name: leaf.name, request: { design, repo, ...(hints === undefined ? {} : { hints }) } });
  }
  for (const { source, leaf } of beyond) unplanned.push({ source, name: leaf.name, reason: "beyond max_leaves" });
  return { planned, unplanned };
}
