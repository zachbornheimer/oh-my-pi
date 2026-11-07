import { createHash } from "node:crypto";

/** Characters trimmed from the edges of each word when comparing statements (agentmux statementPunct). */
const STATEMENT_PUNCT = ".,;:!?\"'`";
const RESOURCE_PUNCT = `${STATEMENT_PUNCT}()[]{}`;
const ID_HASH_BYTES = 8;
export const BULLET_PREFIXES: readonly string[] = ["- ", "* ", "• "];

/** File extensions that mark a word of a statement as a resource (agentmux inferredResourceExts). */
const RESOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".go",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".sql",
  ".toml",
  ".mod",
  ".rs",
  ".swift",
  ".rb",
]);

export const fields = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

function trimEdges(word: string, characters: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && characters.includes(word[start] as string)) start += 1;
  while (end > start && characters.includes(word[end - 1] as string)) end -= 1;
  return word.slice(start, end);
}

/** Lower-cased words with edge punctuation removed, joined by one space: the key two statements are compared by. */
export function normalizeStatement(statement: string): string {
  return fields(statement.toLowerCase())
    .map((word) => trimEdges(word, STATEMENT_PUNCT))
    .filter((word) => word !== "")
    .join(" ");
}

function extensionOf(word: string): string {
  const base = word.slice(word.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot);
}

/** The words of a statement that name a file with a known extension. */
export function inferredResources(statement: string): string[] {
  return fields(statement)
    .map((word) => trimEdges(word, RESOURCE_PUNCT))
    .filter((word) => word !== "" && RESOURCE_EXTENSIONS.has(extensionOf(word).toLowerCase()));
}

/** The id given, or `n_` and 16 hex digits of the normalized statement's SHA-256. */
export function stableNodeId(provided: string, statement: string): string {
  const id = provided.trim();
  if (id !== "") return id;
  const digest = createHash("sha256").update(normalizeStatement(statement)).digest("hex");
  return `n_${digest.slice(0, ID_HASH_BYTES * 2)}`;
}

/** Trimmed, non-empty, first-seen-order union of string lists. */
export function unionStrings(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const item = raw.trim();
      if (item === "" || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** The text of each bullet line, in order; blank lines and non-bullet lines are ignored. */
export function bulletStatements(text: string): string[] {
  const statements: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const prefix = BULLET_PREFIXES.find((candidate) => line.startsWith(candidate));
    if (prefix === undefined) continue;
    const statement = line.slice(prefix.length).trim();
    if (statement !== "") statements.push(statement);
  }
  return statements;
}

export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
