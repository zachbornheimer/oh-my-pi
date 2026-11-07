// The type surface of agentmux internal/depupgrade, field for field: snapshot.go (Snapshot, Timing, File,
// Package, CICheck, Verdict, CheckName, Check, ChangeKind, Change, Report), facts.go (Facts, PackageFacts),
// ports.go (Import), testdiff.go (TestDiffFact, Hunk), facade.go (FacadeFact), step_applicable.go
// (ApplicableEntry), and the internal/changelog types they carry (types.go, range.go).
//
// Every JSON name is the Go `json:` tag, so the shape is the Go shape after JSON normalization. A field with
// `omitempty` is optional. Go decodes a `null` (and a missing key) to the field's zero value, so the decoders
// below do the same: a missing or null string is "", list is [], struct is the zero struct, number is 0, boolean
// is false. Any other type, and any value outside a closed set, throws a message naming the field.

// changelog (internal/changelog/types.go, range.go)

/** agentmux `changelog.Ecosystem`: the namespaces a Range can name. */
export const ECOSYSTEMS = ["npm", "go", "pypi", "composer"] as const;

/**
 * Go's `Ecosystem` is a plain string, and `EcosystemOf` returns "" when no changed manifest names one, so this
 * is any string rather than the four constants alone.
 */
export type Ecosystem = string;

/** agentmux `changelog.Kind`: what an entry means to someone upgrading. */
export const ENTRY_KINDS = ["breaking", "deprecation", "security", "behavior", "fix", "other"] as const;
export type Kind = (typeof ENTRY_KINDS)[number];

/** agentmux `changelog.SourceRenovateNotes`: entries taken from notes pasted into an upgrade PR. */
export const SOURCE_RENOVATE_NOTES = "renovate-pr-notes";

/** One change note for one version (`changelog.Entry`). */
export interface Entry {
  version: string;
  kind: Kind;
  text: string;
  /** Where the note came from: a GitHub release, the repository's CHANGELOG.md, or `renovate-pr-notes`. */
  source: string;
}

/** One published security advisory the upgrade touches (`changelog.Advisory`). */
export interface Advisory {
  id: string;
  severity: string;
  summary: string;
  url: string;
  affected: string;
}

/** An upgrade: every version after `from`, up to and including `to` (`changelog.Range`). */
export interface Range {
  ecosystem: Ecosystem;
  package: string;
  /** Version the package moves from, exclusive. */
  from: string;
  /** Version the package moves to, inclusive. */
  to: string;
}

/** Everything known about the versions in a Range, and the gaps where nothing was fetched (`changelog.Changelog`). */
export interface Changelog {
  range: Range;
  entries: Entry[];
  advisories: Advisory[];
  sources: string[];
  gaps: string[];
}

// facts (internal/depupgrade/ports.go, testdiff.go, facade.go, step_applicable.go)

/** One import statement of a package, as written in `path` at `line` (`Import`). */
export interface Import {
  path: string;
  /** 1-based line number of the statement in `path`. */
  line: number;
  statement: string;
}

/** agentmux `HunkKind`: why a changed test line is suspicious. */
export const HUNK_KINDS = ["removed_assertion", "added_skip"] as const;
export type HunkKind = (typeof HUNK_KINDS)[number];

/** One suspicious changed line in a test file (`Hunk`). */
export interface Hunk {
  path: string;
  kind: HunkKind;
  line: string;
}

/** What the PR did to its tests: every test file touched, and the lines that weaken one (`TestDiffFact`). */
export interface TestDiffFact {
  changed: string[];
  suspicious: Hunk[];
}

/** Whether a package needs a facade and who owns it (`FacadeFact`). */
export interface FacadeFact {
  required: boolean;
  owner?: string;
  reason: string;
}

/** A changelog entry the model judged applies here, with its reason (`ApplicableEntry`; Go embeds the entry). */
export interface ApplicableEntry extends Entry {
  why: string;
}

/** One path the PR changes, with the diff GitHub reports for it (`File`). */
export interface File {
  path: string;
  patch?: string;
  lockfile?: boolean;
  manifest?: boolean;
  test?: boolean;
}

/** A package name with the version it moves from and to (`Package`). */
export interface Package {
  name: string;
  from: string;
  to: string;
}

/** One required gate the PR already ran (`CICheck`). */
export interface CICheck {
  name: string;
  passed: boolean;
}

/** What is known about one bumped package (`PackageFacts`). */
export interface PackageFacts {
  package: Package;
  changelog: Changelog;
  aliases: string[];
  alias_evidence?: string[];
  importers: string[];
  import_sites: Import[];
  used_symbols: string[];
  matched_entries: Entry[];
  /** Empty until the model has judged them (step_applicable.go). */
  applicable_entries?: ApplicableEntry[];
  /**
   * Every line that runs the package's binary instead of importing it (a script naming `node_modules/.bin/<name>`,
   * a package runner, a process call from another language). A replica addition: the Go Facts has no such field.
   */
  executions?: Import[];
  unit: string;
  facade: FacadeFact;
}

/** Everything the judge reads, none of it guessed (`Facts`). */
export interface Facts {
  ecosystem: Ecosystem;
  packages: PackageFacts[];
  /** Each unit lists the names of the packages it holds, in the snapshot's order (`[][]string`). */
  units: string[][];
  test_diff: TestDiffFact;
  ci: CICheck[];
  lockfile: string[];
  manifest: string[];
  gaps?: string[];
  /** Excerpt of a failed check log. The canary that a caller of this upgrade broke. Absent when CI is green. */
  red_log?: string;
}

// snapshot (internal/depupgrade/snapshot.go)

/** One stage of building a Snapshot and its wall time (`Timing`; the Go field is `MS`, the JSON name `wall_ms`). */
export interface Timing {
  name: string;
  wall_ms: number;
}

/**
 * One dependency-upgrade PR, already loaded (`Snapshot`): the pull URL expanded with Facts gathered from the PR,
 * the tree and the changelogs. `facts` is absent when nothing was gathered, which the judge reads as not_proven,
 * and `timings` are the stages that built the Snapshot.
 */
export interface Snapshot {
  url?: string;
  title?: string;
  body: string;
  files: File[];
  packages: Package[];
  ci?: CICheck[];
  notes?: string[];
  facts?: Facts;
  timings?: Timing[];
}

// report (internal/depupgrade/snapshot.go, judge.go)

/** agentmux `Verdict`: one judgment. */
export const VERDICTS = ["passed", "failed", "not_proven"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** agentmux `CheckName`: the judge's closed set of criteria, in order. */
export const CHECK_NAMES = [
  "one_module",
  "lockfile",
  "tests_unweakened",
  "changelog",
  "ci",
  "call_sites_reviewed",
  "facade",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** One named criterion and what was observed (`Check`). */
export interface Check {
  name: CheckName;
  verdict: Verdict;
  observed: string;
}

// decoders

type Obj = Record<string, unknown>;

function object(value: unknown, where: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  return value as Obj;
}

/** A struct field: missing or null is the zero struct, decoded from `{}`. */
function struct<T>(value: unknown, where: string, decode: (record: Obj, where: string) => T): T {
  return decode(value === undefined || value === null ? {} : object(value, where), where);
}

function text(record: Obj, key: string, where: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${where}.${key}: expected a string`);
  return value;
}

function optionalText(record: Obj, key: string, where: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return text(record, key, where);
}

function integer(record: Obj, key: string, where: string): number {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${where}.${key}: expected an integer`);
  return value;
}

function flag(record: Obj, key: string, where: string): boolean {
  const value = record[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${where}.${key}: expected a boolean`);
  return value;
}

function optionalFlag(record: Obj, key: string, where: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where}.${key}: expected a boolean`);
  return value;
}

function oneOf<const Choices extends readonly string[]>(
  record: Obj,
  key: string,
  where: string,
  choices: Choices,
): Choices[number] {
  const value = record[key];
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${where}.${key}: expected one of ${choices.join(", ")}`);
  }
  return value as Choices[number];
}

/** A list field: missing or null is the empty list. */
function list<T>(record: Obj, key: string, where: string, decode: (item: unknown, where: string) => T): T[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${where}.${key}: expected an array`);
  return value.map((item, index) => decode(item, `${where}.${key}[${index}]`));
}

function optionalList<T>(
  record: Obj,
  key: string,
  where: string,
  decode: (item: unknown, where: string) => T,
): T[] | undefined {
  return record[key] === undefined ? undefined : list(record, key, where, decode);
}

function stringItem(item: unknown, where: string): string {
  if (typeof item !== "string") throw new Error(`${where}: expected a string`);
  return item;
}

function stringList(record: Obj, key: string, where: string): string[] {
  return list(record, key, where, stringItem);
}

function entryOf(value: unknown, where: string): Entry {
  const record = object(value, where);
  return {
    version: text(record, "version", where),
    kind: oneOf(record, "kind", where, ENTRY_KINDS),
    text: text(record, "text", where),
    source: text(record, "source", where),
  };
}

function applicableEntryOf(value: unknown, where: string): ApplicableEntry {
  const record = object(value, where);
  return { ...entryOf(record, where), why: text(record, "why", where) };
}

function advisoryOf(value: unknown, where: string): Advisory {
  const record = object(value, where);
  return {
    id: text(record, "id", where),
    severity: text(record, "severity", where),
    summary: text(record, "summary", where),
    url: text(record, "url", where),
    affected: text(record, "affected", where),
  };
}

function rangeOf(record: Obj, where: string): Range {
  return {
    ecosystem: text(record, "ecosystem", where),
    package: text(record, "package", where),
    from: text(record, "from", where),
    to: text(record, "to", where),
  };
}

function changelogOf(record: Obj, where: string): Changelog {
  return {
    range: struct(record.range, `${where}.range`, rangeOf),
    entries: list(record, "entries", where, entryOf),
    advisories: list(record, "advisories", where, advisoryOf),
    sources: stringList(record, "sources", where),
    gaps: stringList(record, "gaps", where),
  };
}

function importOf(value: unknown, where: string): Import {
  const record = object(value, where);
  return {
    path: text(record, "path", where),
    line: integer(record, "line", where),
    statement: text(record, "statement", where),
  };
}

function hunkOf(value: unknown, where: string): Hunk {
  const record = object(value, where);
  return {
    path: text(record, "path", where),
    kind: oneOf(record, "kind", where, HUNK_KINDS),
    line: text(record, "line", where),
  };
}

function testDiffOf(record: Obj, where: string): TestDiffFact {
  return { changed: stringList(record, "changed", where), suspicious: list(record, "suspicious", where, hunkOf) };
}

function facadeOf(record: Obj, where: string): FacadeFact {
  const owner = optionalText(record, "owner", where);
  return {
    required: flag(record, "required", where),
    ...(owner === undefined ? {} : { owner }),
    reason: text(record, "reason", where),
  };
}

function fileOf(value: unknown, where: string): File {
  const record = object(value, where);
  const patch = optionalText(record, "patch", where);
  const lockfile = optionalFlag(record, "lockfile", where);
  const manifest = optionalFlag(record, "manifest", where);
  const test = optionalFlag(record, "test", where);
  return {
    path: text(record, "path", where),
    ...(patch === undefined ? {} : { patch }),
    ...(lockfile === undefined ? {} : { lockfile }),
    ...(manifest === undefined ? {} : { manifest }),
    ...(test === undefined ? {} : { test }),
  };
}

function packageOf(record: Obj, where: string): Package {
  return { name: text(record, "name", where), from: text(record, "from", where), to: text(record, "to", where) };
}

function packageItem(value: unknown, where: string): Package {
  return packageOf(object(value, where), where);
}

function ciCheckOf(value: unknown, where: string): CICheck {
  const record = object(value, where);
  return { name: text(record, "name", where), passed: flag(record, "passed", where) };
}

function packageFactsOf(value: unknown, where: string): PackageFacts {
  const record = object(value, where);
  const aliasEvidence = optionalList(record, "alias_evidence", where, stringItem);
  const applicable = optionalList(record, "applicable_entries", where, applicableEntryOf);
  const executions = optionalList(record, "executions", where, importOf);
  return {
    package: struct(record.package, `${where}.package`, packageOf),
    changelog: struct(record.changelog, `${where}.changelog`, changelogOf),
    aliases: stringList(record, "aliases", where),
    ...(aliasEvidence === undefined ? {} : { alias_evidence: aliasEvidence }),
    importers: stringList(record, "importers", where),
    import_sites: list(record, "import_sites", where, importOf),
    used_symbols: stringList(record, "used_symbols", where),
    matched_entries: list(record, "matched_entries", where, entryOf),
    ...(applicable === undefined ? {} : { applicable_entries: applicable }),
    ...(executions === undefined ? {} : { executions }),
    unit: text(record, "unit", where),
    facade: struct(record.facade, `${where}.facade`, facadeOf),
  };
}

function factsOf(record: Obj, where: string): Facts {
  const gaps = optionalList(record, "gaps", where, stringItem);
  const redLog = record.red_log === null ? undefined : optionalText(record, "red_log", where);
  return {
    ecosystem: text(record, "ecosystem", where),
    packages: list(record, "packages", where, packageFactsOf),
    units: list(record, "units", where, (unit, unitWhere) => {
      if (unit === null) return [];
      if (!Array.isArray(unit)) throw new Error(`${unitWhere}: expected an array`);
      return unit.map((name, index) => stringItem(name, `${unitWhere}[${index}]`));
    }),
    test_diff: struct(record.test_diff, `${where}.test_diff`, testDiffOf),
    ci: list(record, "ci", where, ciCheckOf),
    lockfile: stringList(record, "lockfile", where),
    manifest: stringList(record, "manifest", where),
    ...(gaps === undefined ? {} : { gaps }),
    ...(redLog === undefined ? {} : { red_log: redLog }),
  };
}

function timingOf(value: unknown, where: string): Timing {
  const record = object(value, where);
  return { name: text(record, "name", where), wall_ms: integer(record, "wall_ms", where) };
}

/** Decodes the Facts a Snapshot carries; throws naming the first bad field. */
export function decodeFacts(value: unknown): Facts {
  return factsOf(object(value, "facts"), "facts");
}

/**
 * Decodes a Snapshot from parsed JSON the way Go's decoder does (null and missing fields take their zero value;
 * unknown keys are dropped). Throws an Error naming the field that is the wrong type or outside its closed set,
 * for example `snapshot.files[2].path: expected a string`.
 */
export function decodeSnapshot(value: unknown): Snapshot {
  const where = "snapshot";
  const record = object(value, where);
  const url = optionalText(record, "url", where);
  const title = optionalText(record, "title", where);
  const ci = optionalList(record, "ci", where, ciCheckOf);
  const notes = optionalList(record, "notes", where, stringItem);
  const timings = optionalList(record, "timings", where, timingOf);
  const facts = record.facts === undefined || record.facts === null
    ? undefined
    : factsOf(object(record.facts, `${where}.facts`), `${where}.facts`);
  return {
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    body: text(record, "body", where),
    files: list(record, "files", where, fileOf),
    packages: list(record, "packages", where, packageItem),
    ...(ci === undefined ? {} : { ci }),
    ...(notes === undefined ? {} : { notes }),
    ...(facts === undefined ? {} : { facts }),
    ...(timings === undefined ? {} : { timings }),
  };
}
