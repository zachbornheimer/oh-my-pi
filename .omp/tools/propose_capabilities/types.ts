/** Shapes shared by the whole tool: the sources it reads, the leaves it proposes and the output it returns. */

export const SOURCE_KINDS = ["conversation", "file", "folder"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What a leaf capability is made of: code only, a model call, or an effect on the machine or a service. */
export const LEAF_KINDS = ["deterministic", "model", "host"] as const;
export type LeafKind = (typeof LEAF_KINDS)[number];

export type Phase = 1 | 2;

export const MIN_SAMPLES = 1;
export const DEFAULT_SAMPLES = 3;
export const MAX_SAMPLES = 5;
/** How many samples must propose a concept for it to be kept. */
export const DEFAULT_MIN_AGREEMENT = 2;

/** A namespace is one lower-case word, such as "webmaster": every proposed name starts with it and a dot. */
export const NAMESPACE = /^[a-z][a-z0-9_]*$/;
/** A capability name: dotted lower-case snake_case words, each shaped like a namespace. */
export function isCapabilityName(name: string): boolean {
  return name.split(".").every((word) => NAMESPACE.test(word));
}

/**
 * One thing to propose capabilities for, already read: `body` is the bounded text the model reads, `anchors` are the
 * evidence it may cite (paths for a file or folder, turn numbers for a conversation).
 */
export interface Source {
  /** The argument as the caller wrote it: `claude:<id>`, a file path or a folder path. */
  readonly ref: string;
  readonly kind: SourceKind;
  readonly body: string;
  readonly anchors: readonly string[];
  /** True when the reader cut the source at its size limits, so `body` is part of it. */
  readonly truncated: boolean;
}

/** A candidate leaf as the model proposes it. */
export interface Leaf {
  readonly name: string;
  /** One sentence: what someone gets by running it. */
  readonly purpose: string;
  /** Why it is worth being a capability. */
  readonly reason: string;
  readonly input_summary: string;
  readonly output_summary: string;
  /** The names of the input's fields; phase 2 pseudocode must name each. */
  readonly input_fields: readonly string[];
  readonly output_fields: readonly string[];
  readonly kind: LeafKind;
  /** `path`, `path:line` or a turn number from the source. */
  readonly evidence: readonly string[];
}

/** One proposal of a sample: the sample's number (from 1) and the name it gave. */
export interface Member {
  readonly sample: number;
  readonly name: string;
}

export interface ProposedCapability extends Leaf {
  /** How many of the run's samples proposed this concept, under any name. */
  readonly agreement: number;
  /** The proposals of the samples this capability groups. */
  readonly members: readonly Member[];
  /** The name the reconciled capability had before the confirming model renamed it. */
  readonly renamed_from?: string;
  readonly pseudocode?: string;
}

export interface Merged {
  /** A proposal that was folded into a kept capability under another name. */
  readonly name: string;
  /** The kept capability it is a member of. */
  readonly into: string;
}

export interface Rejected {
  readonly name: string;
  /** Why it went, in one line. */
  readonly objection: string;
  /** The criteria the confirming model found it failing; empty when it went before that, for lack of agreement. */
  readonly failed_criteria: readonly string[];
  /** How many samples proposed it. */
  readonly agreement?: number;
  /** The proposals of the samples it groups. */
  readonly members?: readonly Member[];
}

export interface CallCounts {
  readonly propose: number;
  readonly reconcile: number;
  readonly confirm: number;
  readonly pseudocode: number;
}

export interface SourceRun {
  readonly source: string;
  readonly kind: SourceKind;
  readonly samples: number;
  readonly capabilities: readonly ProposedCapability[];
  readonly merged: readonly Merged[];
  readonly rejected: readonly Rejected[];
  /** The model calls this source took, by purpose (retries after a refused reply are not counted). */
  readonly usage: { readonly calls: CallCounts };
}

export interface ProposeCapabilitiesOutput {
  readonly runs: readonly SourceRun[];
  readonly namespace?: string;
  /** The registered names under `namespace` the proposals were held against; empty without a namespace. */
  readonly registered: readonly string[];
  readonly totals: {
    readonly sources: number;
    readonly kept: number;
    readonly merged: number;
    readonly rejected: number;
    readonly calls: CallCounts;
  };
}

/** What the caller gives: a source is a string to read (a conversation ref, a file or a folder) or one already read. */
export interface ProposeCapabilitiesInput {
  readonly sources: readonly (string | Source)[];
  readonly namespace?: string;
  readonly phase?: Phase;
  readonly samples?: number;
  readonly min_agreement?: number;
  /** Registered capability names to leave out. Omitted with a namespace: the installed omp tools are listed instead. */
  readonly registered?: readonly string[];
}
