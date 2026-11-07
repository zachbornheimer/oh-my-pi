/** Small validators for a model's JSON reply: each throws a message that names the field, which is what a re-ask shows the model. */

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function reqObject(value: unknown, what: string): Obj {
  if (!isObj(value)) throw new Error(`${what} must be an object`);
  return value;
}

export function reqString(object: Obj, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function optString(object: Obj, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string when present`);
  return value;
}

export function reqBool(object: Obj, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function reqArray(object: Obj, key: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

export function reqStringArray(object: Obj, key: string): string[] {
  const items = reqArray(object, key);
  if (items.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${key} must hold non-empty strings`);
  return items as string[];
}

export function oneOf<T extends string>(object: Obj, key: string, allowed: readonly T[]): T {
  const value = object[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** The identifier of a Linear ticket: a team key, a dash, a number. */
export const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The ticket as the tools name it: trimmed and upper-cased; throws when it is not an identifier. */
export function ticketId(raw: string): string {
  const ticket = raw.trim().toUpperCase();
  if (!LINEAR_ID.test(ticket)) throw new Error(`"${raw}" is not a Linear ticket identifier such as ZYS-123`);
  return ticket;
}
