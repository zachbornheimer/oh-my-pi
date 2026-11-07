/**
 * A small JSON Schema checker for language-question replies. Supported: type (name or list), enum, const, properties,
 * required, additionalProperties (boolean or schema), items (one schema), minItems, maxItems, uniqueItems, minLength,
 * maxLength, pattern, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, minProperties, maxProperties,
 * anyOf, oneOf, allOf, not, and local `$ref` into `$defs` / `definitions`. Annotation keywords (title, description,
 * default, examples, $schema, $id, $comment, deprecated, readOnly, writeOnly) are ignored, and so is `format`: it is
 * NOT checked. Any other keyword makes `compileSchema` throw, so a schema this checker cannot enforce fails before a
 * model is asked. Copied, not imported, into every tool directory that validates replies.
 */

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set([
  "title", "description", "default", "examples", "$schema", "$id", "$comment", "deprecated", "readOnly", "writeOnly",
  "format", "$defs", "definitions",
]);
const KEYWORDS = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minProperties", "maxProperties", "anyOf", "oneOf", "allOf", "not", "$ref",
]);

const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws when `schema` uses anything this checker cannot enforce. `path` names the position in errors. */
export function compileSchema(schema: unknown, path = "schema", root: unknown = schema): void {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw new Error(`${path} is not a JSON Schema object`);
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) throw new Error(`${path} uses the keyword "${key}", which cannot be checked`);
  }
  const type = schema.type;
  for (const name of Array.isArray(type) ? type : type === undefined ? [] : [type]) {
    if (typeof name !== "string" || !TYPES.has(name)) throw new Error(`${path} has an unknown type ${JSON.stringify(name)}`);
  }
  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern, "u");
    } catch (error) {
      throw new Error(`${path} has a pattern that is not a regular expression: ${(error as Error).message}`);
    }
  }
  if (typeof schema.$ref === "string") resolveRef(schema.$ref, root, path);
  if (isObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) compileSchema(child, `${path}.properties.${name}`, root);
  }
  if (schema.additionalProperties !== undefined) compileSchema(schema.additionalProperties, `${path}.additionalProperties`, root);
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) throw new Error(`${path}.items as a list (tuple form) cannot be checked`);
    compileSchema(schema.items, `${path}.items`, root);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = schema[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${path}.${key} must be a list`);
    list.forEach((child, index) => compileSchema(child, `${path}.${key}[${index}]`, root));
  }
  if (schema.not !== undefined) compileSchema(schema.not, `${path}.not`, root);
}

function resolveRef(ref: string, root: unknown, path: string): unknown {
  if (ref === "#") return root;
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  const table = match === null || !isObject(root) ? undefined : root[match[1]!];
  const target = isObject(table) ? table[match![2]!.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  if (target === undefined) throw new Error(`${path} has a $ref (${ref}) that is not a local $defs or definitions entry`);
  return target;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, name: string): boolean {
  const actual = typeOf(value);
  return actual === name || (name === "number" && actual === "integer");
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every reason `value` does not satisfy `schema`; an empty list means it does. Call `compileSchema` first. */
export function violations(value: unknown, schema: unknown, at = "reply", root: unknown = schema): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  const s = schema as Schema;
  const found: string[] = [];
  if (typeof s.$ref === "string") found.push(...violations(value, resolveRef(s.$ref, root, at), at, root));
  if (s.type !== undefined) {
    const names = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!names.some((name) => matchesType(value, name))) {
      found.push(`${at}: expected ${names.join(" or ")}, got ${typeOf(value)}`);
      return found;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => same(option, value))) {
    found.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  }
  if ("const" in s && !same(s.const, value)) found.push(`${at}: must equal ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof s.minLength === "number" && length < s.minLength) found.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && length > s.maxLength) found.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) found.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) found.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) found.push(`${at}: above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) found.push(`${at}: not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) found.push(`${at}: not below ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const quotient = value / s.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) found.push(`${at}: not a multiple of ${s.multipleOf}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) found.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) found.push(`${at}: more than ${s.maxItems} items`);
    if (s.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      found.push(`${at}: items are not unique`);
    }
    if (s.items !== undefined) value.forEach((item, index) => found.push(...violations(item, s.items, `${at}[${index}]`, root)));
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) found.push(`${at}: fewer than ${s.minProperties} properties`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) found.push(`${at}: more than ${s.maxProperties} properties`);
    if (Array.isArray(s.required)) {
      for (const name of s.required) if (!(name in value)) found.push(`${at}: missing required "${name}"`);
    }
    const properties = isObject(s.properties) ? s.properties : {};
    for (const key of keys) {
      if (key in properties) found.push(...violations(value[key], properties[key], `${at}.${key}`, root));
      else if (s.additionalProperties === false) found.push(`${at}: "${key}" is not allowed`);
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
        found.push(...violations(value[key], s.additionalProperties, `${at}.${key}`, root));
      }
    }
  }
  if (Array.isArray(s.allOf)) for (const child of s.allOf) found.push(...violations(value, child, at, root));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((child) => violations(value, child, at, root).length === 0)) {
    found.push(`${at}: matches none of the anyOf alternatives`);
  }
  if (Array.isArray(s.oneOf)) {
    const matching = s.oneOf.filter((child) => violations(value, child, at, root).length === 0).length;
    if (matching !== 1) found.push(`${at}: matches ${matching} of the oneOf alternatives, not exactly one`);
  }
  if (s.not !== undefined && violations(value, s.not, at, root).length === 0) found.push(`${at}: matches a schema it must not match`);
  return found;
}
