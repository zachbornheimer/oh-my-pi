import type { DagNode } from "./types.js";
import { byteLength, fields, normalizeStatement, unionStrings } from "./text.js";

/** Statements shorter than this many words never merge by prefix. */
const MIN_OVERLAP_TOKENS = 3;

/** The smaller id, the longer statement, the union of the lists; provenance stays the first node's. */
function mergeNodes(first: DagNode, second: DagNode): DagNode {
  const merged = { ...first };
  if (second.ID < first.ID) merged.ID = second.ID;
  if (byteLength(second.Statement) > byteLength(first.Statement)) merged.Statement = second.Statement;
  merged.Obligations = unionStrings(first.Obligations, second.Obligations);
  merged.Constraints = unionStrings(first.Constraints, second.Constraints);
  merged.Resources = unionStrings(first.Resources, second.Resources);
  merged.Tools = unionStrings(first.Tools, second.Tools);
  return merged;
}

const mergeKey = (node: DagNode): string => normalizeStatement(node.Statement) || node.ID;

/** True when one statement is the other with more words after it (both at least three words, different lengths). */
export function overlappingStatements(a: string, b: string): boolean {
  const first = fields(normalizeStatement(a));
  const second = fields(normalizeStatement(b));
  if (first.length < MIN_OVERLAP_TOKENS || second.length < MIN_OVERLAP_TOKENS) return false;
  if (first.length === second.length) return false;
  const [short, long] = second.length < first.length ? [second, first] : [first, second];
  return short.every((word, index) => long[index] === word);
}

function mergeOverlappingNodes(nodes: readonly DagNode[]): DagNode[] {
  const out: DagNode[] = [];
  for (const node of nodes) {
    const at = out.findIndex((existing) => overlappingStatements(existing.Statement, node.Statement));
    if (at < 0) {
      out.push(node);
    } else {
      out[at] = mergeNodes(out[at] as DagNode, node);
    }
  }
  return out;
}

/** Nodes with the same normalized statement merge, then prefix-overlapping statements merge; the result is sorted by id. */
export function mergeDuplicateNodes(nodes: readonly DagNode[]): DagNode[] {
  const byKey = new Map<string, DagNode>();
  for (const node of nodes) {
    const key = mergeKey(node);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? node : mergeNodes(existing, node));
  }
  return mergeOverlappingNodes([...byKey.values()]).sort((a, b) => (a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0));
}
