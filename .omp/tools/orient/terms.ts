import { keywordsOf } from "./keywords.js";

/**
 * The search terms of a plain-language behavior. Prose words come from `find`'s `keywordsOf`; an identifier named in
 * the prose (`additionalContext`, `state_dir`, `CONTEXT_SEPARATOR`) also yields its snake_case and joined spellings,
 * because the code may spell it differently than the person describing it (Rust `additional_context` for a JSON
 * `additionalContext`). Pure.
 */

const isAlphanumeric = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z0-9]$/.test(char);
const isSeparator = (char: string | undefined): boolean => char === "_" || char === "." || char === "-";

/** Words joined by `_`, `-` or `.` that start at `start`: a letter-led word, then one or more separator-and-word groups. Its length, 0 when none. */
function joinedWordsLength(text: string, start: number): number {
  if (!/^[A-Za-z]$/.test(text[start] ?? "")) return 0;
  let end = start + 1;
  while (isAlphanumeric(text[end])) end += 1;
  let groups = 0;
  while (isSeparator(text[end]) && isAlphanumeric(text[end + 1])) {
    end += 1;
    while (isAlphanumeric(text[end])) end += 1;
    groups += 1;
  }
  return groups === 0 ? 0 : end - start;
}

const CAMEL_CASE = /[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*/y;
const PASCAL_CASE = /[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*/y;

/** The identifiers a text names, left to right: words joined by `_`, `-` or `.`, camelCase, or PascalCase with an inner capital. */
export function identifiersIn(text: string): string[] {
  const found: string[] = [];
  let at = 0;
  while (at < text.length) {
    let length = joinedWordsLength(text, at);
    if (length === 0) {
      for (const pattern of [CAMEL_CASE, PASCAL_CASE]) {
        pattern.lastIndex = at;
        const match = pattern.exec(text);
        if (match !== null) {
          length = match[0].length;
          break;
        }
      }
    }
    if (length === 0) {
      at += 1;
    } else {
      found.push(text.slice(at, at + length));
      at += length;
    }
  }
  return found;
}

/** `additionalContext` → `["additional", "context"]`; `CONTEXT_SEPARATOR` → `["context", "separator"]`. */
export function identifierParts(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== "");
}

/** The snake_case and joined spellings of every identifier the texts name: the strongest signal a scan has. */
export function identifierTermsOf(...texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const token of identifiersIn(text)) {
      const parts = identifierParts(token);
      if (parts.length < 2) continue;
      seen.add(parts.join("_"));
      seen.add(parts.join(""));
    }
  }
  return [...seen];
}

export function termsOf(...texts: readonly string[]): string[] {
  return [...new Set([...keywordsOf(...texts), ...identifierTermsOf(...texts)])];
}
