// Port of agentmux internal/depupgrade/peerrange.go: an npm-style range expression ("^19.3.0",
// ">=16.8 <20", "^17 || ^18") tested against a concrete version.

type Semver = [number, number, number];

interface Partial {
  v: Semver;
  parts: number;
}

function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

/** parsePartial: a possibly incomplete version, "19", "19.x" or "19.3.0". */
function parsePartial(raw: string): Partial | undefined {
  let text = raw.trim();
  if (text.startsWith("v")) text = text.slice(1);
  const cut = text.search(/[-+]/);
  if (cut >= 0) text = text.slice(0, cut);
  const p: Partial = { v: [0, 0, 0], parts: 0 };
  const fields = text.split(".");
  for (let i = 0; i < fields.length; i++) {
    if (i >= p.v.length) return undefined;
    const part = fields[i]!;
    if (part === "x" || part === "X" || part === "*" || part === "") break;
    if (!/^\d+$/.test(part)) return undefined;
    p.v[i] = Number(part);
    p.parts = i + 1;
  }
  return p;
}

/** caretSpan is how many leading parts a caret range pins: up to and including the first non-zero one. */
function caretSpan(p: Partial): number {
  for (let i = 0; i < p.parts; i++) {
    if (p.v[i]! !== 0) return i + 1;
  }
  return p.parts;
}

function tildeSpan(p: Partial): number {
  return p.parts >= 2 ? 2 : 1;
}

/** upperBound is the first version past every version sharing the first `span` parts of `p`. */
function upperBound(p: Partial, span: number): Semver {
  const out: Semver = [0, 0, 0];
  for (let i = 0; i < span; i++) out[i] = p.v[i]!;
  out[span - 1] = out[span - 1]! + 1;
  return out;
}

const COMPARATOR_OPS = [">=", "<=", ">", "<", "=", "^", "~"] as const;

function comparatorIncludes(comparator: string, v: Semver): boolean {
  let op = "";
  let c = comparator;
  for (const candidate of COMPARATOR_OPS) {
    if (c.startsWith(candidate)) {
      op = candidate;
      c = c.slice(candidate.length);
      break;
    }
  }
  const p = parsePartial(c);
  if (p === undefined) return false;
  if (p.parts === 0) return true;
  switch (op) {
    case ">=":
      return compare(v, p.v) >= 0;
    case ">":
      return compare(v, upperBound(p, p.parts)) >= 0;
    case "<=":
      return compare(v, upperBound(p, p.parts)) < 0;
    case "<":
      return compare(v, p.v) < 0;
    case "^":
      return compare(v, p.v) >= 0 && compare(v, upperBound(p, caretSpan(p))) < 0;
    case "~":
      return compare(v, p.v) >= 0 && compare(v, upperBound(p, tildeSpan(p))) < 0;
    default:
      return compare(v, p.v) >= 0 && compare(v, upperBound(p, p.parts)) < 0;
  }
}

function clauseIncludes(clause: string, v: Semver): boolean {
  for (const c of clause.split(/\s+/).filter((field) => field !== "")) {
    if (!comparatorIncludes(c, v)) return false;
  }
  return true;
}

/** RangeIncludes reports whether an npm-style range expression admits `version`. */
export function RangeIncludes(expr: string, version: string): boolean {
  const p = parsePartial(version);
  if (p === undefined || p.parts === 0) return false;
  for (const clause of expr.split("||")) {
    if (clauseIncludes(clause.trim(), p.v)) return true;
  }
  return false;
}
