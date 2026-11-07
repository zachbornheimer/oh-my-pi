/**
 * A few row validators with the `parse` and `infer` shape the SQLite readers were written against, so the tool needs no
 * schema library. `parse` throws on the first value that does not fit; a field's absence is `undefined` only where the
 * shape says `.optional()`.
 */
export interface Shape<T> {
  check(value: unknown, path: string): T;
  parse(value: unknown): T;
  nullable(): Shape<T | null>;
  optional(): Shape<T | undefined>;
  /** Type-only carrier for `Infer`. */
  readonly _type?: T;
}

export type Infer<S> = S extends Shape<infer T> ? T : never;

function shape<T>(check: (value: unknown, path: string) => T): Shape<T> {
  const self = {
    check,
    parse: (value: unknown) => check(value, "value"),
    nullable: () => shape<T | null>((value, path) => (value === null ? null : check(value, path))),
    optional: () => shape<T | undefined>((value, path) => (value === undefined ? undefined : check(value, path))),
  };
  return self;
}

type Checked<T> = Shape<T>;

const fail = (path: string, expected: string, value: unknown): never => {
  throw new Error(`${path}: expected ${expected}, got ${value === null ? "null" : typeof value}`);
};

export const z = {
  string: (): Checked<string> => shape((value, path) => (typeof value === "string" ? value : fail(path, "a string", value))),
  number: (): Checked<number> =>
    shape((value, path) => (typeof value === "number" && Number.isFinite(value) ? value : fail(path, "a number", value))),
  enum: <const V extends readonly string[]>(values: V): Checked<V[number]> =>
    shape((value, path) =>
      typeof value === "string" && values.includes(value) ? (value as V[number]) : fail(path, `one of ${values.join(", ")}`, value),
    ),
  array: <T>(element: Checked<T>): Checked<T[]> =>
    shape((value, path) =>
      Array.isArray(value) ? value.map((item, index) => element.check(item, `${path}[${index}]`)) : fail(path, "an array", value),
    ),
  object: <F extends Record<string, Checked<unknown>>>(
    fields: F,
  ): Checked<{ [K in keyof F]: F[K] extends Checked<infer T> ? T : never }> =>
    shape((value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(path, "an object", value);
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) out[key] = field.check(record[key], `${path}.${key}`);
      return out as { [K in keyof F]: F[K] extends Checked<infer T> ? T : never };
    }),
};
