import type { Fact } from "./inventory_facts.ts";

/** What one fact read from an asset. `code` -1 means the fact could not be read at all and `output` says why. */
export interface InventoryFact {
  /** Which fixed fact this is. */
  fact: Fact;
  /** The command or network read that produced it, for the record. */
  command_line: string;
  /** The command's exit code; -1 when the fact was not read. */
  code: number;
  /** What it printed (with errors merged in), or why it could not be read. */
  output: string;
}

/** What the fixed read-only facts printed for the asset: `measured` with each, or `unmeasured` with a reason. */
export type AssetInventory =
  | { status: "measured"; measured_at: string; facts: InventoryFact[] }
  | { status: "unmeasured"; reason: string };
export type MeasuredAssetInventory = Extract<AssetInventory, { status: "measured" }>;
