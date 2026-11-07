import { compareBytes, quote } from "../gotext.js";
import type { Ecosystem, Range } from "../schemas.js";

// Port of agentmux internal/changelog/range.go: an upgrade range and the semver ordering behind it.

const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "go", "pypi", "composer"];

interface Version {
  core: [number, number, number];
  pre: string[];
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(raw: string): Version | undefined {
  const m = VERSION_PATTERN.exec(raw.trim());
  if (m === null) return undefined;
  const v: Version = { core: [0, 0, 0], pre: [] };
  for (let i = 0; i < v.core.length; i++) {
    const field = m[i + 1];
    if (field === undefined || field === "") continue;
    v.core[i] = Number(field);
  }
  if (m[4] !== undefined && m[4] !== "") v.pre = m[4].split(".");
  return v;
}

function compareInts(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return compareInts(Number(a), Number(b));
  if (numericA) return -1;
  if (numericB) return 1;
  return compareBytes(a, b);
}

/** comparePrerelease follows semver 2.0: a release outranks its prereleases, numeric identifiers compare as numbers and rank below alphanumeric ones. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const c = compareIdentifier(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return compareInts(a.length, b.length);
}

/** compareVersions orders two semantic versions: -1, 0, or 1. A version that does not parse sorts before every one that does. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === undefined && vb === undefined) return 0;
  if (va === undefined) return -1;
  if (vb === undefined) return 1;
  for (let i = 0; i < va.core.length; i++) {
    const c = compareInts(va.core[i]!, vb.core[i]!);
    if (c !== 0) return c;
  }
  return comparePrerelease(va.pre, vb.pre);
}

/** isPrerelease reports whether a version names a prerelease (range.go isPrerelease). */
export function isPrerelease(raw: string): boolean {
  const v = parseVersion(raw);
  return v !== undefined && v.pre.length > 0;
}

/** Validate says whether the Range names a real, forward upgrade, throwing Go's message when it does not. */
export function validateRange(r: Range): void {
  if (!ECOSYSTEMS.includes(r.ecosystem)) {
    throw new Error(`changelog: unknown ecosystem ${quote(r.ecosystem)} (want npm, go, pypi, or composer)`);
  }
  if (r.package.trim() === "") throw new Error("changelog: package is required");
  for (const v of [r.from, r.to]) {
    if (parseVersion(v) === undefined) throw new Error(`changelog: ${quote(v)} is not a version for ${r.package}`);
  }
  if (compareVersions(r.from, r.to) >= 0) {
    throw new Error(`changelog: ${r.package} from ${r.from} is not before to ${r.to}`);
  }
}

/** Contains reports whether version is after From and no later than To. */
export function contains(r: Range, version: string): boolean {
  if (parseVersion(version) === undefined) return false;
  return compareVersions(version, r.from) > 0 && compareVersions(version, r.to) <= 0;
}

/**
 * tagVersion reads the version a release tag names for pkg. A tag carrying a package prefix ("pkg@1.2.3")
 * belongs to that package alone. A bare tag ("v1.2.3") belongs to pkg only when the repository's releases
 * track it (mainPackage); otherwise it names some sibling package's release.
 */
export function tagVersion(tag: string, pkg: string, mainPackage: boolean): string | undefined {
  let name = "";
  let raw = tag;
  const at = tag.lastIndexOf("@");
  if (at > 0) {
    name = tag.slice(0, at);
    raw = tag.slice(at + 1);
  }
  if (name === "" && !mainPackage) return undefined;
  if (name !== "" && name !== pkg) return undefined;
  const v = raw.startsWith("v") ? raw.slice(1) : raw;
  return parseVersion(v) === undefined ? undefined : v;
}
