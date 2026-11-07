/** Narrow decoders for what `gh` and `git` print. Each throws a message that names where the bad value was. */

export type Obj = Record<string, unknown>;

export function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${where}: not JSON (${(error as Error).message})`);
  }
}

export function obj(value: unknown, where: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  return value as Obj;
}

export function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value;
}

export function str(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  return value;
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${where}: expected a boolean`);
  return value;
}

/** A string, or null/undefined as undefined. */
export function optStr(value: unknown, where: string): string | undefined {
  return value === undefined || value === null ? undefined : str(value, where);
}

const SHA = /^[0-9a-f]{40}$/i;

export function sha(value: unknown, where: string): string {
  const text = str(value, where);
  if (!SHA.test(text)) throw new Error(`${where}: expected a 40-character commit SHA`);
  return text;
}

/**
 * Parses `gh api graphql --paginate` output without requiring `--slurp` (older `gh` releases lack it). Accepts a JSON
 * array (`--slurp`), a single JSON page object, or concatenated JSON page objects.
 */
export function parsePaginatedPages(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const pages: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index++) {
      const ch = trimmed[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
      } else if (ch === "{") {
        if (depth === 0) start = index;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          pages.push(JSON.parse(trimmed.slice(start, index + 1)));
          start = -1;
        }
      }
    }
    if (pages.length === 0 || depth !== 0) {
      throw new Error(`unparseable paginated GraphQL output: ${trimmed.slice(0, 120)}`);
    }
    return pages;
  }
}
