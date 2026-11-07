import { readFile } from "node:fs/promises";

/**
 * Reading a service credential out of the environment, or out of one line of a secrets file, and reading fields
 * out of a service's JSON reply. Copied from the Mastra capability's shared adapters so this tool has no outside
 * dependency.
 *
 * The homelab keeps its service keys in the Home Assistant host's `/config/secrets.yaml`. Two footguns live here:
 * - the YAML value arrives quoted, and the service answers 401 to the quoted form, so one pair of matching
 *   surrounding quotes, and only that pair, comes off;
 * - `path#name` picks one `name: value` line out of a file of secrets, with a trailing comment dropped.
 */

/** Reads a credential file as UTF-8: the seam a test replaces. */
export type CredentialReader = (path: string) => Promise<string>;

/** The reader production uses. */
export const readCredentialFile: CredentialReader = (path) => readFile(path, "utf8");

/** One pair of matching surrounding quotes comes off: `"abc"` and `'abc'` become `abc`; `ab'c` is left alone. */
export function normalizeCredential(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  const quoted = (quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote);
  return (quoted ? trimmed.slice(1, -1) : trimmed).trim();
}

/** The value of one `name: value` line of a YAML secrets file, trailing comment dropped, quotes left on. */
export function yamlValue(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "m").exec(text);
  if (found === null) return null;
  const value = found[1]!.replace(/\s+#.*$/, "").trim();
  return value === "" ? null : value;
}

/** `path#name` -> both halves; split on the last `#` so a path may contain one. */
export function splitCredentialReference(reference: string): [string, string | undefined] {
  const cut = reference.lastIndexOf("#");
  return cut === -1 ? [reference, undefined] : [reference.slice(0, cut), reference.slice(cut + 1)];
}

export interface CredentialSource {
  /** The inline variable's value, such as `env.UNIFI_API_KEY`. */
  readonly inline?: string | undefined;
  /** The file variable's value, such as `env.UNIFI_API_KEY_FILE`; it may carry `#name`. */
  readonly file?: string | undefined;
  /** The file variable's own name, as the messages spell it. */
  readonly fileVariable: string;
  /** The whole sentence to throw when neither is set. */
  readonly missing: string;
}

/** The inline value, else the file, else the refusal naming both variables. The inline value wins. */
export async function resolveCredential(
  source: CredentialSource,
  readFileImpl: CredentialReader = readCredentialFile,
): Promise<string> {
  const inline = source.inline?.trim();
  if (inline) return normalizeCredential(inline);
  const reference = source.file?.trim();
  if (!reference) throw new Error(source.missing);
  const [path, name] = splitCredentialReference(reference);
  let text: string;
  try {
    text = await readFileImpl(path);
  } catch (error) {
    throw new Error(
      `${source.fileVariable} ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = name === undefined ? normalizeCredential(text) : yamlValue(text, name);
  if (value === null) throw new Error(`${source.fileVariable} ${path} states no \`${name}\` line`);
  const credential = normalizeCredential(value);
  if (credential === "") throw new Error(`${source.fileVariable} ${path} holds an empty credential`);
  return credential;
}

/** True for `1`, `true`, `yes`, `on` (case-insensitive): how an environment states a flag. */
export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

type Row = Record<string, unknown>;

/** The first of `keys` the row carries as a value that is neither absent, `null`, nor the empty string. */
export function field(row: Row, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** A field as text, or null when the row carries none. A number reads as its decimal spelling. */
export function fieldText(row: Row, ...keys: readonly string[]): string | null {
  const value = field(row, keys);
  return value === undefined ? null : String(value);
}

/** A field as a finite number, or null when the row carries none or carries something that is not a number. */
export function fieldNumber(row: Row, ...keys: readonly string[]): number | null {
  const value = field(row, keys);
  if (value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A field as a boolean, or null when the row carries neither a boolean nor its text. */
export function fieldBool(row: Row, ...keys: readonly string[]): boolean | null {
  const value = field(row, keys);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
