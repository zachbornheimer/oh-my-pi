/** One goal or obligation to place in the graph. */
export interface WorkUnit {
  id: string;
  statement: string;
  obligations: string[];
  constraints: string[];
  resources: string[];
  tools: string[];
}

/** Explicit work units, or text that becomes one unit. */
export interface CreateDagInput {
  units: WorkUnit[];
  text: string;
}

export interface Provenance {
  ParentID: string;
  Source: "input" | "decomposed";
}

export interface DagNode {
  ID: string;
  Statement: string;
  Obligations: string[];
  Constraints: string[];
  Resources: string[];
  Tools: string[];
  Provenance: Provenance;
}

/** An edge `From` -> `To`: `To` needs `From`'s output. */
export interface SemanticEdge {
  From: string;
  To: string;
  Evidence: string;
}

export interface Mutex {
  A: string;
  B: string;
}

export interface Uncertainty {
  A: string;
  B: string;
  Reason: string;
}

export interface ResourceNeed {
  Node: string;
  Resources: string[];
}

export interface GraphNode {
  ID: string;
  DependsOn: string[];
  Done: boolean;
}

/** The validated semantic DAG. */
export interface CreateDagResult {
  Graph: { Nodes: GraphNode[] };
  Nodes: DagNode[];
  SemanticEdges: SemanticEdge[];
  Mutexes: Mutex[];
  OpenUncertainty: Uncertainty[];
  ResourceRequirements: ResourceNeed[];
  Ready: string[];
}
