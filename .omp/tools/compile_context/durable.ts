import type { CompileContextInput, ContextItem, OmittedContext, ProjectState } from "./schemas.js";
import { trimSpace } from "./text.js";

export const SOURCE_PROJECT_STATE = "project_state";
export const SOURCE_WORK_ITEM = "work_item";
const DEFAULT_WORK_REF = "work";
export const REASON_NOT_NEEDED = "not needed by work item";
const KIND_CONSTRAINT = "constraint";
const STATUS_OPEN = "open";
const STATUS_BLOCKED = "blocked";

/** `<project_id>@rev<rev>`: the exact state revision every durable item came from. */
export function stateRef(state: ProjectState): string {
  return `${state.project_id}@rev${state.rev}`;
}

/** The items every bundle must hold (project, intent, work item, needed obligations) and the obligations left out. */
export function requiredDurableItems(input: CompileContextInput): { items: ContextItem[]; omitted: OmittedContext[] } {
  const { state, work } = input;
  const provenance = { source: SOURCE_PROJECT_STATE, ref: stateRef(state) };
  const name = state.name === undefined || state.name === "" ? state.project_id : state.name;
  const items: ContextItem[] = [
    { kind: "project", id: state.project_id, text: `${name} (${state.project_id})`, required: true, provenance },
  ];
  if (state.intent !== undefined && trimSpace(state.intent) !== "") {
    items.push({ kind: "intent", id: "intent", text: state.intent, required: true, provenance });
  }
  const workRef = work.id === "" ? DEFAULT_WORK_REF : work.id;
  items.push({
    kind: "work_item",
    id: workRef,
    text: work.text,
    required: true,
    provenance: { source: SOURCE_WORK_ITEM, ref: workRef },
  });
  const obligations = selectObligations(input);
  return { items: [...items, ...obligations.items], omitted: obligations.omitted };
}

/** Live obligations the work item names, plus every live constraint; all live ones when it names none. */
function selectObligations(input: CompileContextInput): { items: ContextItem[]; omitted: OmittedContext[] } {
  const named = new Set(input.work.obligation_ids);
  const items: ContextItem[] = [];
  const omitted: OmittedContext[] = [];
  const seen = new Set<string>();
  for (const obligation of input.state.obligations) {
    if (obligation.status !== STATUS_OPEN && obligation.status !== STATUS_BLOCKED) {
      continue;
    }
    const provenance = { source: SOURCE_PROJECT_STATE, ref: `${stateRef(input.state)}#${obligation.id}` };
    const needed = named.size === 0 || named.has(obligation.id) || obligation.kind === KIND_CONSTRAINT;
    if (!needed) {
      omitted.push({ kind: "obligation", id: obligation.id, reason: REASON_NOT_NEEDED, provenance });
      continue;
    }
    if (seen.has(obligation.id)) {
      continue;
    }
    seen.add(obligation.id);
    items.push({ kind: "obligation", id: obligation.id, text: obligation.text, required: true, provenance });
  }
  return { items, omitted };
}
