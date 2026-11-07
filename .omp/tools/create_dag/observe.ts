import type { Atomicity } from "./atomicity.js";
import { mergeDuplicateNodes } from "./merge.js";
import { mapLimit } from "./omp_model.js";
import { bulletStatements, inferredResources, stableNodeId, unionStrings } from "./text.js";
import type { DagNode, WorkUnit } from "./types.js";

export const NO_WORK_MESSAGE = "create_dag: requires units or text";

/** Units judged at once. */
export const MAX_CONCURRENT_UNITS = 8;

/** Is a statement one outcome? `unit` is the unit's index in the request. */
export type JudgeAtomicity = (statement: string, unit: number) => Promise<Atomicity>;

const unitText = (unit: WorkUnit): string => (unit.statement !== "" ? unit.statement : unit.obligations.join("\n"));

function nodeFromUnit(unit: WorkUnit, id: string, parentId: string, source: "input" | "decomposed"): DagNode {
  return {
    ID: id,
    Statement: unit.statement,
    Obligations: [...unit.obligations],
    Constraints: [...unit.constraints],
    Resources: unionStrings(unit.resources, inferredResources(unit.statement)),
    Tools: [...unit.tools],
    Provenance: { ParentID: parentId, Source: source },
  };
}

/** A compound unit's bullet lines as units; each inherits the parent's obligations, constraints, resources and tools. */
function childrenFromBullets(parent: WorkUnit): WorkUnit[] {
  return bulletStatements(parent.statement).map((statement) => ({
    id: "",
    statement,
    obligations: [...parent.obligations],
    constraints: [...parent.constraints],
    resources: [...parent.resources],
    tools: [...parent.tools],
  }));
}

async function observeUnit(raw: WorkUnit, index: number, judge: JudgeAtomicity): Promise<DagNode[]> {
  const statement = raw.statement.trim() !== "" ? raw.statement.trim() : unitText(raw).trim();
  if (statement === "") {
    throw new Error(`create_dag: unit ${index} (${JSON.stringify(raw.id)}) has no statement or obligations`);
  }
  const unit: WorkUnit = { ...raw, statement };
  const parentId = stableNodeId(unit.id, unit.statement);
  const atomicity = await judge(unit.statement, index);
  const children = atomicity === "compound" ? childrenFromBullets(unit) : [];
  if (children.length === 0) return [nodeFromUnit(unit, parentId, "", "input")];
  return children.map((child) => nodeFromUnit(child, stableNodeId(child.id, child.statement), parentId, "decomposed"));
}

/**
 * Turns the request into nodes: each unit stays one node when atomic and splits into its bullets when compound
 * (a compound unit without bullets stays one node), then duplicates and prefix-overlaps merge. Units are judged
 * MAX_CONCURRENT_UNITS at a time; node order is unit order before the merge sorts by id.
 */
export async function observeWork(units: readonly WorkUnit[], text: string, judge: JudgeAtomicity): Promise<DagNode[]> {
  const asked: readonly WorkUnit[] = units.length > 0 ? units : [wholeText(text)];
  const nodes = (await mapLimit(asked, MAX_CONCURRENT_UNITS, (unit, index) => observeUnit(unit, index, judge))).flat();
  return mergeDuplicateNodes(nodes);
}

function wholeText(text: string): WorkUnit {
  const statement = text.trim();
  if (statement === "") throw new Error(NO_WORK_MESSAGE);
  return { id: "", statement, obligations: [], constraints: [], resources: [], tools: [] };
}
