import { type CatalogEntry, catalogFromJson, entriesOfKind, forHarness, type SuggestionKind } from "./catalog.js";
import {
  decideOutcomes,
  type JudgeContext,
  type JudgeDeps,
  judgeKinds,
  REASON_EMPTY_CATALOG,
  SUGGEST_KINDS,
  type Suggestions,
  unavailableSuggestions,
} from "./judge.js";
import { discoverSkills } from "./skills.js";

export const NO_PROMPT_MESSAGE = "suggest_skills_tools_and_mcp requires a prompt";

export interface SuggestInput {
  text: unknown;
  FullPrompt?: string | null;
  InFlight?: string | null;
  RecentTurns?: readonly string[] | null;
  Harness?: string | null;
  /** Candidates to judge besides the installed skills: entries, the MCP tool file shape, `{skills, tools, mcp_tools}`, or a JSON string of any. */
  Catalog?: unknown;
  CatalogJson?: string | null;
  /** Judge installed skills too (default true). */
  InstalledSkills?: boolean | null;
}

export interface SuggestDeps extends JudgeDeps {
  /** The skill roots to scan, nearest first; see `skillRoots`. */
  skillRoots: readonly string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The first entry of a name wins, per kind, so the caller's own entries override an installed skill of the same name. */
function dedupe(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return SUGGEST_KINDS.flatMap((kind) => entriesOfKind(entries, kind));
}

/**
 * Suggests which installed skill, tool or MCP tool a prompt should use. Installed skills are read from the skill roots
 * on disk; tools and MCP tools come from the caller's catalog (a custom tool cannot list the session's tools). Every
 * candidate of a kind is judged by the model, each on its own; each kind keeps what clears the 0.6 bar, at most 5.
 * A request that fails is a note; only when nothing could be judged is the result `Degraded`. A blank prompt or a
 * cancellation throws.
 */
export async function runSuggest(input: SuggestInput, deps: SuggestDeps): Promise<Suggestions> {
  const prompt = typeof input.text === "string" ? input.text.trim() : "";
  if (prompt === "") throw new Error(NO_PROMPT_MESSAGE);

  const notes: string[] = [];
  const errors: string[] = [];
  const supplied: CatalogEntry[] = [];
  for (const source of [input.Catalog, input.CatalogJson]) {
    if (source === undefined || source === null || (typeof source === "string" && source.trim() === "")) continue;
    const parsed = catalogFromJson(source);
    supplied.push(...parsed.entries);
    errors.push(...parsed.errors);
  }

  const installed: CatalogEntry[] = [];
  if (input.InstalledSkills !== false) {
    const found = await discoverSkills(deps.skillRoots, deps.signal);
    installed.push(...found.entries);
    notes.push(...found.errors);
  }

  const harness = (input.Harness ?? "").trim();
  const entries = dedupe(forHarness([...supplied, ...installed], harness));
  if (errors.length > 0) {
    if (entries.length === 0) return { ...unavailableSuggestions(`load catalog: ${errors.join("; ")}`), Notes: notes };
    notes.push(`catalog source dropped: ${errors.join("; ")}`);
  }
  if (entries.length === 0) {
    return { Suggestions: [], Reason: REASON_EMPTY_CATALOG, Degraded: false, Notes: notes, Scores: {}, Ranking: {} };
  }

  const context: JudgeContext = {
    request: prompt,
    fullPrompt: input.FullPrompt ?? "",
    inFlight: input.InFlight ?? "",
    recentTurns: input.RecentTurns ?? [],
  };
  const byKind = new Map<SuggestionKind, CatalogEntry[]>(SUGGEST_KINDS.map((kind) => [kind, entriesOfKind(entries, kind)]));
  try {
    const outcomes = await judgeKinds(context, byKind, deps);
    const decided = decideOutcomes(outcomes);
    return { ...decided, Notes: [...notes, ...decided.Notes] };
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`judge candidates: ${messageOf(error)}`);
  }
}
