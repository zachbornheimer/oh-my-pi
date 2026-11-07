import type { CreateDagResult, DagNode, GraphNode, Mutex, SemanticEdge, Uncertainty } from "./types.js";

/** The graph is malformed: a dependency cycle or a repeated node id. Nothing is ever reported ready from a malformed graph. */
export class DependencyGraphError extends Error {
  constructor(
    readonly kind: "cycle" | "duplicate_node",
    detail: string,
  ) {
    super(`create_dag: classify task graph: validate task graph: ${detail}`);
    this.name = "DependencyGraphError";
  }
}

const sameEdge = (a: SemanticEdge, b: SemanticEdge): boolean => a.From === b.From && a.To === b.To;

function reaches(edges: readonly SemanticEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === to) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return edges.some((edge) => edge.From === id && walk(edge.To));
  };
  return edges.some((edge) => edge.From === from && walk(edge.To));
}

/** Transitive reduction: an edge is dropped when the other edges already connect its ends by a longer path. */
export function reduceSemanticEdges(edges: readonly SemanticEdge[]): SemanticEdge[] {
  if (edges.length < 2) return [...edges];
  return edges.filter((edge) => !reaches(edges.filter((other) => !sameEdge(other, edge)), edge.From, edge.To));
}

function graphFrom(nodes: readonly DagNode[], edges: readonly SemanticEdge[]): GraphNode[] {
  const dependsOn = new Map<string, string[]>();
  for (const edge of edges) dependsOn.set(edge.To, [...(dependsOn.get(edge.To) ?? []), edge.From]);
  return nodes.map((node) => ({ ID: node.ID, DependsOn: dependsOn.get(node.ID) ?? [], Done: false }));
}

/** Rejects a repeated id and any dependency cycle, with agentmux taskgraph's messages. */
export function validateGraph(graph: readonly GraphNode[]): void {
  const byId = new Map<string, GraphNode>();
  for (const node of graph) {
    if (byId.has(node.ID)) {
      throw new DependencyGraphError("duplicate_node", `taskgraph: duplicate node id: ${JSON.stringify(node.ID)}`);
    }
    byId.set(node.ID, node);
  }
  const marks = new Map<string, "in_progress" | "finished">();
  const visit = (id: string): void => {
    const mark = marks.get(id);
    if (mark === "finished") return;
    if (mark === "in_progress") {
      throw new DependencyGraphError("cycle", `taskgraph: dependency cycle: through ${JSON.stringify(id)}`);
    }
    marks.set(id, "in_progress");
    for (const dependency of (byId.get(id) as GraphNode).DependsOn) visit(dependency);
    marks.set(id, "finished");
  };
  for (const node of graph) visit(node.ID);
}

const resourceNeeds = (nodes: readonly DagNode[]) =>
  nodes.filter((node) => node.Resources.length > 0).map((node) => ({ Node: node.ID, Resources: [...node.Resources] }));

export interface Judged {
  readonly edges: readonly SemanticEdge[];
  readonly mutexes: readonly Mutex[];
  readonly uncertainty: readonly Uncertainty[];
}

/** Reduces the edges, builds the graph, validates it, and reads the ready nodes (those depending on nothing). */
export function assembleDag(nodes: readonly DagNode[], judged: Judged): CreateDagResult {
  const edges = reduceSemanticEdges(judged.edges);
  const graph = graphFrom(nodes, edges);
  validateGraph(graph);
  return {
    Graph: { Nodes: graph },
    Nodes: [...nodes],
    SemanticEdges: edges,
    Mutexes: [...judged.mutexes],
    OpenUncertainty: [...judged.uncertainty],
    ResourceRequirements: resourceNeeds(nodes),
    Ready: graph.filter((node) => node.DependsOn.length === 0).map((node) => node.ID),
  };
}
