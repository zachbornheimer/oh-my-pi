#!/usr/bin/env bun
/**
 * Resolves the ordered branch list for one omp-build assembly run.
 *
 * Usage: bun .omp-build/resolve-branches.ts [branches_override] [event_name]
 *
 * - The single source of truth is the directory `.omp-build/branches/`: one
 *   TOML file per carried branch. The file's path under `branches/`, minus
 *   `.toml`, is the branch name (`branches/fix/foo.toml` is branch `fix/foo`),
 *   so a file and its branch cannot drift apart.
 * - File fields:
 *     reason    required, plain English: what the branch does for the person
 *               running this build.
 *     upstream  no | candidate | submitted | merged (default "no").
 *     pr        required when upstream = "submitted": the upstream PR number
 *               or URL.
 *     layer     integer merge order, lower first (default 50).
 * - Order is (layer, path), so ties are alphabetical and deterministic.
 * - Any invalid file fails the run with the file named: missing/empty reason,
 *   unknown key, bad `upstream`, `submitted` without `pr`, non-integer `layer`,
 *   an unusable branch name, or a duplicate branch name.
 * - A workflow_dispatch with a NON-EMPTY `branches_override` uses that
 *   comma-separated list instead and publishes a prerelease, never latest. An
 *   empty override (or absent input) reads the directory, so a dispatch can
 *   never assemble a branchless build.
 *
 * Prints exactly one branch name per line on stdout (possibly none); a
 * human-readable table goes to stderr. Existence on the fork and "already
 * merged upstream" are checked by the workflow after it fetches the branches.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const UPSTREAM_STATUSES = ["no", "candidate", "submitted", "merged"] as const;
export type UpstreamStatus = (typeof UPSTREAM_STATUSES)[number];

export interface BranchEntry {
  branch: string;
  file: string;
  reason: string;
  upstream: UpstreamStatus;
  pr?: string;
  layer: number;
}

const ALLOWED_KEYS = new Set(["reason", "upstream", "pr", "layer"]);
const DEFAULT_LAYER = 50;

/** A branch name safe to hand to git and the shell: no leading dash or dot, no `..`, no empty segments. */
export function assertBranchName(name: string, where: string): void {
  const valid = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name)
    && !name.includes("..")
    && !name.includes("//")
    && !name.endsWith("/")
    && !name.endsWith(".")
    && !name.endsWith(".lock")
    && !name.split("/").some(segment => segment.startsWith(".") || segment.endsWith(".lock"));
  if (!valid) {
    throw new Error(`${where}: \`${name}\` is not a usable git branch name`);
  }
}

/** Validates one parsed branch file. `file` is the repo-relative path used in error messages. */
export function parseBranchFile(branch: string, file: string, parsed: unknown): BranchEntry {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: must be a TOML table of fields`);
  }
  const fields = parsed as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${file}: unknown key \`${key}\` (allowed: ${[...ALLOWED_KEYS].join(", ")})`);
    }
  }
  assertBranchName(branch, file);

  const reason = fields.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      `${file}: missing \`reason\` - every branch states in plain English what it does for the person running this build`,
    );
  }
  if (/^\s*todo\b/i.test(reason)) {
    console.warn(`::warning file=${file},title=Unconfirmed branch reason::${branch}: reason is still a TODO`);
  }

  const upstream = fields.upstream ?? "no";
  if (typeof upstream !== "string" || !(UPSTREAM_STATUSES as readonly string[]).includes(upstream)) {
    throw new Error(
      `${file}: \`upstream\` must be one of ${UPSTREAM_STATUSES.join(" | ")}, got ${JSON.stringify(upstream)}`,
    );
  }

  let pr: string | undefined;
  const rawPr = fields.pr;
  if (rawPr !== undefined) {
    if (typeof rawPr === "number" && Number.isInteger(rawPr) && rawPr > 0) {
      pr = String(rawPr);
    } else if (typeof rawPr === "string" && rawPr.trim().length > 0) {
      pr = rawPr.trim();
    } else if (!(typeof rawPr === "string" && rawPr.trim().length === 0)) {
      throw new Error(`${file}: \`pr\` must be a PR number or URL, got ${JSON.stringify(rawPr)}`);
    }
  }
  if (upstream === "submitted" && pr === undefined) {
    throw new Error(`${file}: \`upstream = "submitted"\` requires \`pr\` (the upstream PR number or URL)`);
  }

  const layer = fields.layer ?? DEFAULT_LAYER;
  if (typeof layer !== "number" || !Number.isInteger(layer)) {
    throw new Error(`${file}: \`layer\` must be an integer, got ${JSON.stringify(layer)}`);
  }

  return { branch, file, reason, upstream: upstream as UpstreamStatus, pr, layer };
}

function listTomlFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".toml")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Reads every `*.toml` under `dir`, validates it, and returns the entries ordered by (layer, path). */
export function readBranchDirectory(dir: string, displayRoot: string = dir): BranchEntry[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir}: branch directory does not exist`);
  }
  const entries: BranchEntry[] = [];
  for (const full of listTomlFiles(dir)) {
    const relative = path.relative(dir, full).split(path.sep).join("/");
    const file = `${displayRoot}/${relative}`;
    const branch = relative.slice(0, -".toml".length);
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${file}: not valid TOML: ${detail}`);
    }
    entries.push(parseBranchFile(branch, file, parsed));
  }
  assertNoDuplicates(entries.map(entry => entry.branch));
  entries.sort((a, b) => a.layer - b.layer || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return entries;
}

export function parseOverride(raw: string): string[] {
  const names = raw
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  for (const name of names) assertBranchName(name, "branches_override");
  return names;
}

export function assertNoDuplicates(branches: string[]): void {
  const duplicates = branches.filter((branch, index) => branches.indexOf(branch) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate branch entries: ${[...new Set(duplicates)].join(", ")}`);
  }
}

if (import.meta.main) {
  const override = process.argv[2] ?? "";
  const event = process.argv[3] ?? "workflow_dispatch";
  const dir = path.join(import.meta.dir, "branches");
  try {
    let branches: string[];
    if (event === "workflow_dispatch" && override.trim().length > 0) {
      branches = parseOverride(override);
      assertNoDuplicates(branches);
    } else {
      const entries = readBranchDirectory(dir, ".omp-build/branches");
      if (entries.length === 0) {
        throw new Error(".omp-build/branches: no branch files - a normal run must merge at least one branch");
      }
      for (const entry of entries) {
        const pr = entry.pr ? ` pr=${entry.pr}` : "";
        console.error(`layer ${String(entry.layer).padStart(3)}  ${entry.branch}  [upstream=${entry.upstream}${pr}]`);
      }
      branches = entries.map(entry => entry.branch);
    }
    console.log(branches.join("\n"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`::error title=Branch manifest::${detail}`);
    process.exit(1);
  }
}
