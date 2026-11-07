/** The three things the tool can suggest (agentmux SuggestionKind). */
export const SUGGESTION_KINDS = ["skill", "tool", "mcp_tool"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** One candidate the prompt may be matched to. */
export interface CatalogEntry {
  Kind: SuggestionKind;
  Name: string;
  Server: string;
  Description: string;
  /** For a skill, its bare name (the `skill://` key), not a file path. */
  Path: string;
  /** How an agent invokes the candidate. */
  HowToCall: string;
  /** Native tools are scoped to one harness; empty means every harness. */
  Harness: string;
}

const KINDS = new Set<string>(SUGGESTION_KINDS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function field(item: Record<string, unknown>, pascal: string, snake: string): string {
  const value = item[pascal] ?? item[snake];
  return typeof value === "string" ? value : "";
}

function kindOf(item: Record<string, unknown>): SuggestionKind | undefined {
  const raw = field(item, "Kind", "kind").trim();
  if (raw === "mcp" || raw === "mcp-tool") return "mcp_tool";
  if (KINDS.has(raw)) return raw as SuggestionKind;
  const name = field(item, "Name", "name");
  if (name.startsWith("mcp__")) return "mcp_tool";
  if (raw === "") return "tool";
  return undefined;
}

function entryOf(value: unknown): { entry: CatalogEntry } | { error: string } {
  const item = asRecord(value);
  if (item === undefined) return { error: "catalog item is not an object" };
  const Kind = kindOf(item);
  const Name = field(item, "Name", "name").trim();
  if (Name === "") return { error: "catalog item has no name" };
  if (Kind === undefined) return { error: `catalog item ${Name} has unknown kind` };
  return {
    entry: {
      Kind,
      Name,
      Server: field(item, "Server", "server"),
      Description: field(item, "Description", "description"),
      Path: field(item, "Path", "path"),
      HowToCall: field(item, "HowToCall", "how_to_call"),
      Harness: field(item, "Harness", "harness"),
    },
  };
}

function tagged(item: unknown, Kind: SuggestionKind): unknown {
  const record = asRecord(item);
  return record === undefined ? item : { Kind, ...record };
}

function itemsOf(value: unknown): unknown[] | { error: string } {
  if (typeof value === "string") {
    try {
      return itemsOf(JSON.parse(value));
    } catch (error) {
      return { error: `catalog JSON: ${(error as Error).message}` };
    }
  }
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record === undefined) return { error: "catalog JSON must be an array or object" };
  if (Array.isArray(record.Catalog)) return record.Catalog;
  const grouped = [
    ...(Array.isArray(record.skills) ? record.skills.map((item) => tagged(item, "skill")) : []),
    ...(Array.isArray(record.tools) ? record.tools.map((item) => tagged(item, "tool")) : []),
    ...(Array.isArray(record.mcp_tools) ? record.mcp_tools.map((item) => tagged(item, "mcp_tool")) : []),
    ...(Array.isArray(record.mcpTools) ? record.mcpTools.map((item) => tagged(item, "mcp_tool")) : []),
  ];
  if (grouped.length > 0) return grouped;
  return { error: "catalog JSON object has no Catalog, skills, tools, or mcp_tools" };
}

/** Caller JSON: capability `Catalog` entries, the MCP tool catalog file, or `{ skills, tools, mcp_tools }`; or a JSON string of any. */
export function catalogFromJson(value: unknown): { entries: CatalogEntry[]; errors: string[] } {
  const items = itemsOf(value);
  if (!Array.isArray(items)) return { entries: [], errors: [items.error] };
  const entries: CatalogEntry[] = [];
  const errors: string[] = [];
  for (const item of items) {
    const parsed = entryOf(item);
    if ("error" in parsed) errors.push(parsed.error);
    else entries.push(parsed.entry);
  }
  return { entries, errors };
}

/** Unscoped entries (empty Harness) and entries matching `harness`; an empty `harness` keeps all. */
export function forHarness(entries: readonly CatalogEntry[], harness: string): CatalogEntry[] {
  return entries.filter((entry) => harness === "" || entry.Harness === "" || entry.Harness === harness);
}

/** The named entries of one kind, one per name (the first wins): a name is the candidate's identity. */
export function entriesOfKind(entries: readonly CatalogEntry[], kind: SuggestionKind): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (entry.Kind === kind && entry.Name !== "" && !byName.has(entry.Name)) byName.set(entry.Name, entry);
  }
  return [...byName.values()];
}
