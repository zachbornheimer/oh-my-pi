import type { Gate } from "./loop/run.js";

/**
 * The reply shapes of the model prompts, the hand decoders that check them, and the report the tool returns. A decoder
 * checks the shape only; what a reply must also satisfy (a version range, a count) is refused in `upgrade.ts`, so the
 * reason reaches the model as a readable message. Every thrown message names the bad field by its path.
 */

export const ENTRY_KINDS = ["breaking", "deprecation", "security", "behavior", "fix", "other"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const USAGE_HOWS = ["direct-import", "binary", "wrapper"] as const;
export type UsageHow = (typeof USAGE_HOWS)[number];

export const USAGE_BASES = ["import-graph", "call-graph", "lockfile-trace", "advisory-trace", "read"] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

/** What the qualifies question calls a pull request: only an `upgrade` runs the five prompts. */
export const PULL_REQUEST_KINDS = ["upgrade", "config_only", "not_dependency"] as const;
export type PullRequestKind = (typeof PULL_REQUEST_KINDS)[number];

export const VERDICTS = ["ready", "needs_work", "skipped"] as const;
export type UpgradeVerdict = (typeof VERDICTS)[number];

export interface PackageChange {
  name: string;
  from: string;
  to: string;
  evidence: string;
}
export interface Changes {
  packages: PackageChange[];
}

export interface ChangelogEntry {
  version: string;
  kind: EntryKind;
  url: string;
  text: string;
}
export interface Advisory {
  id: string;
  url: string;
  affects: string[];
  summary: string;
}
export interface PackageChangelog {
  name: string;
  entries: ChangelogEntry[];
  advisories: Advisory[];
}
export interface Changelog {
  packages: PackageChangelog[];
}

export interface Usage {
  package: string;
  file: string;
  line?: number;
  how: UsageHow;
  basis: UsageBasis;
  symbol?: string;
  evidence: string;
  touched: string;
}
export interface Usages {
  usages: Usage[];
}

export interface FacadeStep {
  order: number;
  what: string;
  green_when: string;
  human?: boolean;
}
export interface FacadePlan {
  needed: boolean;
  reason: string;
  name?: string;
  path?: string;
  owns?: string;
  steps: FacadeStep[];
}

export interface BodyUnit {
  heading: string;
  behavior: string;
}
export interface PrBody {
  units: BodyUnit[];
}

export interface UpgradeReport {
  url: string;
  kind: PullRequestKind;
  verdict: UpgradeVerdict;
  changes: Changes;
  changelog: Changelog;
  usages: Usage[];
  facade: FacadePlan;
  body: PrBody;
  gates: Gate[];
}

type Obj = Record<string, unknown>;

function object(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Obj;
}

function text(record: Obj, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${path}.${key} must be a string`);
  return value;
}

function textOr(record: Obj, key: string, path: string, fallback: string): string {
  return record[key] === undefined || record[key] === null ? fallback : text(record, key, path);
}

function optionalText(record: Obj, key: string, path: string): string | undefined {
  return record[key] === undefined || record[key] === null ? undefined : text(record, key, path);
}

function list(record: Obj, key: string, path: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array`);
  return value;
}

function listOr(record: Obj, key: string, path: string): unknown[] {
  return record[key] === undefined || record[key] === null ? [] : list(record, key, path);
}

function integer(record: Obj, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${path}.${key} must be an integer`);
  return value;
}

function choice<T extends string>(record: Obj, key: string, path: string, allowed: readonly T[]): T {
  const value = record[key];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${path}.${key} must be one of ${allowed.join(", ")}`);
  return found;
}

export function decodeChanges(value: unknown): Changes {
  const root = object(value, "reply");
  return {
    packages: list(root, "packages", "reply").map((item, index) => {
      const path = `reply.packages[${index}]`;
      const pkg = object(item, path);
      return {
        name: text(pkg, "name", path),
        from: text(pkg, "from", path),
        to: text(pkg, "to", path),
        evidence: text(pkg, "evidence", path),
      };
    }),
  };
}

export function decodeChangelog(value: unknown): Changelog {
  const root = object(value, "reply");
  return {
    packages: list(root, "packages", "reply").map((item, index) => {
      const path = `reply.packages[${index}]`;
      const pkg = object(item, path);
      return {
        name: text(pkg, "name", path),
        entries: list(pkg, "entries", path).map((entry, at) => {
          const where = `${path}.entries[${at}]`;
          const record = object(entry, where);
          return {
            version: text(record, "version", where),
            kind: choice(record, "kind", where, ENTRY_KINDS),
            url: text(record, "url", where),
            text: text(record, "text", where),
          };
        }),
        advisories: list(pkg, "advisories", path).map((advisory, at) => {
          const where = `${path}.advisories[${at}]`;
          const record = object(advisory, where);
          return {
            id: textOr(record, "id", where, ""),
            url: text(record, "url", where),
            affects: listOr(record, "affects", where).map((affected, nth) => {
              if (typeof affected !== "string") throw new Error(`${where}.affects[${nth}] must be a string`);
              return affected;
            }),
            summary: text(record, "summary", where),
          };
        }),
      };
    }),
  };
}

export function decodeUsages(value: unknown): Usages {
  const root = object(value, "reply");
  return {
    usages: list(root, "usages", "reply").map((item, index) => {
      const path = `reply.usages[${index}]`;
      const use = object(item, path);
      const line = use.line === undefined || use.line === null ? undefined : integer(use, "line", path);
      const symbol = optionalText(use, "symbol", path);
      return {
        package: text(use, "package", path),
        file: text(use, "file", path),
        ...(line === undefined ? {} : { line }),
        how: choice(use, "how", path, USAGE_HOWS),
        basis: choice(use, "basis", path, USAGE_BASES),
        ...(symbol === undefined ? {} : { symbol }),
        evidence: text(use, "evidence", path),
        touched: text(use, "touched", path),
      };
    }),
  };
}

export function decodeFacade(value: unknown): FacadePlan {
  const root = object(value, "reply");
  const needed = root.needed;
  if (typeof needed !== "boolean") throw new Error("reply.needed must be a boolean");
  const name = optionalText(root, "name", "reply");
  const path = optionalText(root, "path", "reply");
  const owns = optionalText(root, "owns", "reply");
  return {
    needed,
    reason: text(root, "reason", "reply"),
    ...(name === undefined ? {} : { name }),
    ...(path === undefined ? {} : { path }),
    ...(owns === undefined ? {} : { owns }),
    steps: listOr(root, "steps", "reply").map((item, index) => {
      const where = `reply.steps[${index}]`;
      const step = object(item, where);
      const human = step.human === undefined || step.human === null ? undefined : step.human;
      if (human !== undefined && typeof human !== "boolean") throw new Error(`${where}.human must be a boolean`);
      return {
        order: integer(step, "order", where),
        what: text(step, "what", where),
        green_when: text(step, "green_when", where),
        ...(human === undefined ? {} : { human }),
      };
    }),
  };
}

export function decodeBody(value: unknown): PrBody {
  const root = object(value, "reply");
  return {
    units: list(root, "units", "reply").map((item, index) => {
      const path = `reply.units[${index}]`;
      const unit = object(item, path);
      return { heading: text(unit, "heading", path), behavior: text(unit, "behavior", path) };
    }),
  };
}

/** The qualifies reply: `{"Kind": "<one of PULL_REQUEST_KINDS>"}`. */
export function decodeKind(value: unknown, field = "Kind"): PullRequestKind {
  const root = object(value, "reply");
  const picked = root[field];
  const kind = PULL_REQUEST_KINDS.find((candidate) => candidate === picked);
  if (kind === undefined) throw new Error(`reply.${field} must be one of ${PULL_REQUEST_KINDS.join(", ")}`);
  return kind;
}
