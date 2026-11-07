import { nameProblem } from "./capability_name.js";
import type { Leaf, Source } from "./types.js";

export const MAX_LEAVES = 30;
const LINE_SUFFIX = /(?::|#L)\d+(?:-\d+)?$/;
const TURN_PREFIX = /^(?:turn[:\s]*|#)/i;

function siblingProblem(name: string, siblings: readonly string[]): string | undefined {
  return siblings.includes(name)
    ? `"${name}" is already a registered capability: propose only what is missing, not the registered ones (${
      siblings.join(", ")
    })`
    : undefined;
}

/** The anchor a piece of evidence points at: `src/a.ts:12` is `src/a.ts`, `turn 7` is `7`. */
export function anchorOf(evidence: string): string {
  return evidence.trim().replace(LINE_SUFFIX, "").replace(TURN_PREFIX, "");
}

function evidenceProblem(leaf: Leaf, source: Source): string | undefined {
  const anchors = new Set(source.anchors);
  const unknown = leaf.evidence.find((evidence) => !anchors.has(anchorOf(evidence)));
  if (unknown === undefined) return undefined;
  const example = source.anchors[0] ?? "";
  return `"${leaf.name}" cites "${unknown}", which is not in the text: cite a ${
    source.kind === "conversation" ? "turn number" : "path"
  } as written there, such as "${example}"`;
}

/** The registered names under `namespace`: what a proposal for that namespace must not repeat. */
export function registeredSiblings(registered: readonly string[], namespace: string | undefined): string[] {
  return namespace === undefined ? [] : registered.filter((name) => name.startsWith(`${namespace}.`));
}

/** Why the proposal cannot stand, written for the model; undefined when every name, evidence and count is sound. */
export function proposalProblem(
  leaves: readonly Leaf[],
  source: Source,
  namespace?: string,
  siblings: readonly string[] = [],
  maxLeaves = MAX_LEAVES,
): string | undefined {
  if (leaves.length === 0) return "propose at least one capability";
  if (leaves.length > maxLeaves) {
    return `propose at most ${maxLeaves} capabilities: keep the most distinct and useful`;
  }
  const seen = new Set<string>();
  for (const leaf of leaves) {
    if (seen.has(leaf.name)) return `"${leaf.name}" is listed twice: each capability appears once`;
    seen.add(leaf.name);
    const problem = nameProblem(leaf.name, namespace) ?? siblingProblem(leaf.name, siblings)
      ?? evidenceProblem(leaf, source);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
