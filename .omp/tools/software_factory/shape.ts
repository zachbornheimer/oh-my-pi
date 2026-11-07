/**
 * A small schema library: one definition is both the validator of a model's or a file's JSON and the JSON Schema a
 * prompt shows a model. It replaces the zod schemas of the Mastra twin (omp's `pi.zod` validates tool parameters only,
 * and has no `toJSONSchema`). Every failure names the path of the field that broke the shape.
 */

export type JsonSchema = Record<string, unknown>;

export interface Shape<T> {
  readonly json: JsonSchema;
  /** The value as `T`, with defaults filled in; throws `ShapeError` naming the first path that does not fit. */
  parse(value: unknown, path?: string): T;
  readonly optionalField?: true;
  readonly defaulted?: true;
}

export class ShapeError extends Error {
  constructor(
    readonly path: string,
    readonly why: string,
  ) {
    super(`${path === "" ? "value" : path}: ${why}`);
    this.name = "ShapeError";
  }
}

export type Infer<S> = S extends Shape<infer T> ? T : never;

/** The result of a successful or failed parse, for a caller that wants a value rather than an exception. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function safeParse<T>(shape: Shape<T>, value: unknown): Parsed<T> {
  try {
    return { ok: true, value: shape.parse(value) };
  } catch (error) {
    if (error instanceof ShapeError) return { ok: false, error: error.message };
    throw error;
  }
}

const describeType = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

export function str(options: { min?: number; pattern?: RegExp; message?: string } = {}): Shape<string> {
  const json: JsonSchema = { type: "string" };
  if (options.min !== undefined) json.minLength = options.min;
  return {
    json,
    parse(value, path = "") {
      if (typeof value !== "string") throw new ShapeError(path, `expected a string, got ${describeType(value)}`);
      if (options.min !== undefined && value.length < options.min) throw new ShapeError(path, `must be at least ${options.min} character(s)`);
      if (options.pattern !== undefined && !options.pattern.test(value)) {
        throw new ShapeError(path, options.message ?? `must match ${options.pattern}`);
      }
      return value;
    },
  };
}

export function bool(): Shape<boolean> {
  return {
    json: { type: "boolean" },
    parse(value, path = "") {
      if (typeof value !== "boolean") throw new ShapeError(path, `expected a boolean, got ${describeType(value)}`);
      return value;
    },
  };
}

export function int(options: { min?: number; max?: number } = {}): Shape<number> {
  const json: JsonSchema = { type: "integer" };
  if (options.min !== undefined) json.minimum = options.min;
  if (options.max !== undefined) json.maximum = options.max;
  return {
    json,
    parse(value, path = "") {
      if (typeof value !== "number" || !Number.isInteger(value)) throw new ShapeError(path, `expected an integer, got ${describeType(value)}`);
      if (options.min !== undefined && value < options.min) throw new ShapeError(path, `must be at least ${options.min}`);
      if (options.max !== undefined && value > options.max) throw new ShapeError(path, `must be at most ${options.max}`);
      return value;
    },
  };
}

export function oneOf<const V extends readonly string[]>(values: V): Shape<V[number]> {
  return {
    json: { type: "string", enum: [...values] },
    parse(value, path = "") {
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ShapeError(path, `expected one of ${values.join(", ")}, got ${typeof value === "string" ? JSON.stringify(value) : describeType(value)}`);
      }
      return value as V[number];
    },
  };
}

export function arr<T>(item: Shape<T>): Shape<T[]> {
  return {
    json: { type: "array", items: item.json },
    parse(value, path = "") {
      if (!Array.isArray(value)) throw new ShapeError(path, `expected an array, got ${describeType(value)}`);
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
  };
}

/** A field that may be absent (or `null`, which models send for "none"); reads as `undefined` then. */
export function opt<T>(inner: Shape<T>): Shape<T | undefined> & { readonly optionalField: true } {
  return {
    json: inner.json,
    optionalField: true,
    parse(value, path = "") {
      return value === undefined || value === null ? undefined : inner.parse(value, path);
    },
  };
}

/** A field a model may omit: it reads as `value` then. Not `required` in the JSON Schema. */
export function dflt<T>(inner: Shape<T>, value: T): Shape<T> & { readonly defaulted: true } {
  return {
    json: { ...inner.json, default: value },
    defaulted: true,
    parse(given, path = "") {
      return given === undefined || given === null ? value : inner.parse(given, path);
    },
  };
}

/** Adds a rule the structure cannot say: `check` returns the reason a parsed value is refused, or `undefined`. */
export function refine<T>(inner: Shape<T>, check: (value: T) => string | undefined): Shape<T> {
  return {
    json: inner.json,
    parse(value, path = "") {
      const parsed = inner.parse(value, path);
      const why = check(parsed);
      if (why !== undefined) throw new ShapeError(path, why);
      return parsed;
    },
  };
}

type Props = Record<string, Shape<any>>;
type OptionalKeys<P extends Props> = { [K in keyof P]: P[K] extends { optionalField: true } ? K : never }[keyof P];
export type ObjectOf<P extends Props> =
  & { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> }
  & { [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined> };

/** An object of the named fields. Unknown keys are dropped; an optional field that is absent is left out of the result. */
export function obj<P extends Props>(props: P, options: { extend?: Props } = {}): Shape<ObjectOf<P>> {
  const all: Props = { ...props, ...(options.extend ?? {}) };
  const required = Object.entries(all)
    .filter(([, shape]) => shape.optionalField !== true && shape.defaulted !== true)
    .map(([key]) => key);
  return {
    json: {
      type: "object",
      additionalProperties: false,
      required,
      properties: Object.fromEntries(Object.entries(all).map(([key, shape]) => [key, shape.json])),
    },
    parse(value, path = "") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ShapeError(path, `expected an object, got ${describeType(value)}`);
      }
      const given = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, shape] of Object.entries(all)) {
        const here = path === "" ? key : `${path}.${key}`;
        const parsed = shape.parse(given[key], here);
        if (parsed !== undefined) out[key] = parsed;
      }
      return out as ObjectOf<P>;
    },
  };
}

/** A shape that accepts any JSON value untouched; only for data this module never reads into (a stored copy). */
export function any<T>(guard: (value: unknown) => value is T, what: string): Shape<T> {
  return {
    json: {},
    parse(value, path = "") {
      if (!guard(value)) throw new ShapeError(path, `expected ${what}`);
      return value;
    },
  };
}

/** The schema as the text a prompt shows a model. */
export function schemaText(shape: Shape<unknown>): string {
  return JSON.stringify(shape.json, null, 2);
}
