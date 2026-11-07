export interface PlannedProject {
  /** The atask project id; empty when the registry has none for `name` (and for a checkout given by path). */
  id: string;
  name: string;
  /** True when no registered project fits the work: there is nowhere to file the items yet. */
  needsNewProject: boolean;
}

export interface PlannedItem {
  /** Local name of the item within this plan (`t1`, `t2`), what `requires` cites. */
  key: string;
  title: string;
  outcome: string;
  acceptance: string[];
  /** Each check carries its own `size=`; both are empty for a draft. */
  proof: string;
  regression: string;
  /** True when no targeted proof could be grounded: the item is filed without checks, as a draft. */
  draft: boolean;
  draft_reason?: string;
  /** Keys of the items that must complete first. Always earlier in `items`. */
  requires: string[];
  rationale: string;
  /** The goal this item delivers and the segments of the words it came from. */
  goal: string;
  sources: string[];
  /** The id of an open atask task that already states this goal; filing creates nothing for such an item. */
  duplicate_of?: string;
}

/** An item that was filed: its key in the plan and the atask id it got. */
export interface AppliedItem {
  key: string;
  id: string;
}

export interface PlanTasksResult {
  project: PlannedProject;
  items: PlannedItem[];
  /** Empty unless `apply` was true. */
  applied: AppliedItem[];
}
