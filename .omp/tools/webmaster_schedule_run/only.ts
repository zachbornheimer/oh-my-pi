import type { SiteRef } from "./types";

/**
 * Site names a scheduled run is limited to: at least one, none blank, whitespace trimmed, repeats removed.
 * An empty list is an error, not "all". Returns the names the run MUST use: the source validated the trimmed form
 * but then matched the raw names, so `" bpp"` passed validation and silently matched no site.
 */
export function normalizeOnly(only: readonly unknown[]): string[] {
  if (!Array.isArray(only)) throw new Error("only must be a list of site names");
  if (only.length === 0) throw new Error("only must name at least one site; omit it to run every site");
  const names: string[] = [];
  for (const entry of only) {
    if (typeof entry !== "string") throw new Error("only must contain site names (strings)");
    const name = entry.trim();
    if (name === "") throw new Error("only must not contain a blank site name");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface OnlySelection {
  /** Sites to run, in profile order. */
  readonly selected: readonly SiteRef[];
  /** Profiled sites the run was not asked to cover; recorded, never dropped. */
  readonly skipped: readonly SiteRef[];
  /** Requested names that match no profile, in the order given, once each. */
  readonly unknown: readonly string[];
}

/** Split the profiled sites by the `only` names. `undefined` selects every site. */
export function selectOnly(sites: readonly SiteRef[], only: readonly string[] | undefined): OnlySelection {
  if (only === undefined) return { selected: sites, skipped: [], unknown: [] };
  const wanted = new Set(only);
  const known = new Set(sites.map((site) => site.name));
  return {
    selected: sites.filter((site) => wanted.has(site.name)),
    skipped: sites.filter((site) => !wanted.has(site.name)),
    unknown: [...new Set(only.filter((name) => !known.has(name)))],
  };
}
