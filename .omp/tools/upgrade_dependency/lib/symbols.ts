import { compareBytes } from "./gotext.js";
import type { Import, Tree } from "./ports.js";
import type { Ecosystem, Entry } from "./schemas.js";

// Port of agentmux internal/depupgrade/symbols.go: what a repository imports from a package, and the
// changelog entries that bear on those symbols.

/** Symbol markers for imports that name no single export. */
export const SymbolAll = "*";
export const SymbolDefault = "default";

const GO_IMPORT_LINE = /^\s*(?:import\s+)?(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/;
const MAJOR_VERSION = /^v\d+$/;

function goNameFixer(name: string): string {
  return name.replaceAll("-", "_").replaceAll(".", "_");
}

/** goQualifier is the name a Go import line is used under: its alias, else the last path element that is not a major-version suffix. */
export function goQualifier(statement: string): string {
  const m = GO_IMPORT_LINE.exec(statement);
  if (m === null) return "";
  if (m[1] !== undefined && m[1] !== "") return m[1];
  const parts = m[2]!.split("/");
  let last = parts[parts.length - 1]!;
  if (MAJOR_VERSION.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  return goNameFixer(last);
}

const CALL_IMPORT = /^(?:require|import)\s*\(/;
const FROM_CLAUSE = /^(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*\bfrom\b/;
const NAMED_BLOCK = /\{([\s\S]*?)\}/;
const NAMESPACE_AS = /\*\s*(?:as\s+\w+)?/;

function namedImports(block: string): string[] {
  const out: string[] = [];
  for (const part of block.split(",")) {
    const trimmed = part.trim();
    const withoutType = trimmed.startsWith("type ") ? trimmed.slice("type ".length) : trimmed;
    const fields = withoutType.split(/\s+/).filter((field) => field !== "");
    if (fields.length > 0) out.push(fields[0]!);
  }
  return out;
}

/**
 * ImportSymbols parses the names one JavaScript import statement brings in. require() and import()
 * calls and namespace imports are SymbolAll; a default import is SymbolDefault; named imports are the
 * exported names.
 */
export function ImportSymbols(statement: string): string[] {
  const text = statement.trim();
  if (CALL_IMPORT.test(text)) return [SymbolAll];
  const m = FROM_CLAUSE.exec(text);
  if (m === null) return [];
  let clause = m[1]!;
  const out: string[] = [];
  const block = NAMED_BLOCK.exec(clause);
  if (block !== null) {
    out.push(...namedImports(block[1]!));
    clause = clause.replace(NAMED_BLOCK, "");
  }
  if (NAMESPACE_AS.test(clause)) {
    out.push(SymbolAll);
  } else if (clause.replace(/^[\s,]+|[\s,]+$/g, "") !== "") {
    out.push(SymbolDefault);
  }
  return out;
}

function quoteMeta(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** symbolMentions answers whether a text names any used symbol as a word. SymbolAll means the repository uses an unknown set, so everything matches. */
function symbolMentions(symbols: string[]): (text: string) => boolean {
  const words: string[] = [];
  for (const symbol of symbols) {
    if (symbol === SymbolAll) return () => true;
    if (symbol === SymbolDefault) continue;
    words.push(quoteMeta(symbol));
  }
  if (words.length === 0) return () => false;
  const re = new RegExp("\\b(?:" + words.join("|") + ")\\b");
  return (text: string) => re.test(text);
}

/** MatchEntries picks the changelog entries that bear on what the repository uses: entries naming a used symbol, plus every breaking and security entry. */
export function MatchEntries(entries: Entry[], symbols: string[]): Entry[] {
  const mentions = symbolMentions(symbols);
  const out: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === "breaking" || entry.kind === "security" || mentions(entry.text)) out.push(entry);
  }
  return out;
}

async function goSymbols(tree: Tree, root: string, imports: Import[], set: Set<string>): Promise<void> {
  for (const imp of imports) {
    const qualifier = goQualifier(imp.statement);
    if (qualifier === "" || qualifier === "_") continue;
    let names: string[];
    try {
      names = await tree.identifiers(root, imp.path, qualifier);
    } catch (error) {
      throw new Error(`identifiers of ${qualifier} in ${imp.path}: ${(error as Error).message}`, { cause: error });
    }
    for (const name of names) set.add(name);
  }
}

/** symbols lists what the repository uses from the package. JavaScript names come from the import specifiers; Go names come from qualified uses. */
export async function usedSymbols(tree: Tree, root: string, eco: Ecosystem, imports: Import[]): Promise<string[]> {
  const set = new Set<string>();
  if (eco === "go") {
    try {
      await goSymbols(tree, root, imports, set);
    } catch (error) {
      throw new Error(`depupgrade: read Go identifiers: ${(error as Error).message}`, { cause: error });
    }
  } else {
    for (const imp of imports) {
      for (const symbol of ImportSymbols(imp.statement)) set.add(symbol);
    }
  }
  return [...set].sort(compareBytes);
}
