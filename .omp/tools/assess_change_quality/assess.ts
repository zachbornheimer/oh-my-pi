import { compareBytes, formatFloat, quote, trimSpace, utf8Length, utf8Prefix } from "./gotext.js";

/** How much reviewer attention a signal deserves. Not a defect grade. */
export type Triage = "note" | "review";

/** The closed set of deterministic signals. */
export type SignalKind =
  | "file_growth"
  | "public_vocabulary_growth"
  | "configuration_growth"
  | "import_edge_growth"
  | "assertion_reduction"
  | "skipped_test_added"
  | "timeout_widened"
  | "duplicate_path"
  | "repeated_consumer_motif"
  | "facade_bypass";

/** A before/after count for one changed file. */
export interface Measure {
  before: number;
  after: number;
}

export interface TimeoutChange {
  name: string;
  from_seconds: number;
  to_seconds: number;
}

export interface ChangedFile {
  path: string;
  test: boolean;
  lines: Measure;
  public_names: Measure;
  config_keys: Measure;
  import_edges: Measure;
  assertions: Measure;
  skip_markers: Measure;
  timeout_changes: TimeoutChange[];
  hunks: string;
}

export interface DuplicatePathMarker {
  old: string;
  new: string;
}

export interface ConsumerObservation {
  consumer: string;
  motif: string;
  intended_facade: string;
  bypassed_facade: boolean;
}

export interface QualityThresholds {
  lines: number;
  public_names: number;
  config_keys: number;
  import_edges: number;
  consumer_motifs: number;
}

export interface AssessChangeQualityInput {
  purpose: string;
  files: ChangedFile[];
  duplicate_paths: DuplicatePathMarker[];
  consumers: ConsumerObservation[];
  thresholds: QualityThresholds;
}

export interface QualityFinding {
  kind: SignalKind;
  triage: Triage;
  scope: string;
  consumers?: string[];
  evidence: string;
  deeper_review: boolean;
  /** The diff text of the file this finding is scoped to, bounded. Present only inside `review.request.findings`. */
  hunk?: string;
}

/** A question put to a reviewer. This tool never asks it: see `unresolvedReview`. */
export interface ReviewRequest {
  id: string;
  prompt: string;
  purpose?: string;
  options: { id: string; meaning: string }[];
  findings: QualityFinding[];
}

export interface QualityReview {
  status: "unresolved";
  request: ReviewRequest;
}

export interface ChangeQualityAssessment {
  files_examined: number;
  findings: QualityFinding[];
  deeper_review: boolean;
  review?: QualityReview;
  basis: string;
}

const INVALID = "invalid input for assess_change_quality";

function bad(where: string, expected: string): never {
  throw new Error(`${INVALID}: ${where}: expected ${expected}`);
}

/** Text; a missing or `null` value is the empty string. */
function text(value: unknown, where: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") bad(where, "a string");
  return value;
}

/** A flag; a missing or `null` value is false. */
function flag(value: unknown, where: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") bad(where, "true or false");
  return value;
}

/** An integer; a missing or `null` value is 0. */
function count(value: unknown, where: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) bad(where, "an integer");
  return value;
}

/** Any finite number; a missing or `null` value is 0. */
function seconds(value: unknown, where: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) bad(where, "a number");
  return value;
}

/** An object; a missing or `null` value is the empty object. */
function record(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) bad(where, "an object");
  return value as Record<string, unknown>;
}

/** A list of objects; a missing or `null` value is the empty list. */
function list(value: unknown, where: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(where, "an array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) bad(`${where}[${index}]`, "an object");
    return item as Record<string, unknown>;
  });
}

function measure(value: unknown, where: string): Measure {
  const object = record(value, where);
  return { before: count(object.before, `${where}.before`), after: count(object.after, `${where}.after`) };
}

/**
 * The call's arguments with absent and `null` fields read as their empty value, the way the Go original decoded them,
 * and any wrongly typed field refused. Every field is optional: an empty call is a valid, quiet assessment.
 */
export function normalizeInput(params: unknown): AssessChangeQualityInput {
  const input = record(params, "the call");
  const thresholds = record(input.thresholds, "thresholds");
  return {
    purpose: text(input.purpose, "purpose"),
    files: list(input.files, "files").map((file, index): ChangedFile => {
      const where = `files[${index}]`;
      return {
        path: text(file.path, `${where}.path`),
        test: flag(file.test, `${where}.test`),
        lines: measure(file.lines, `${where}.lines`),
        public_names: measure(file.public_names, `${where}.public_names`),
        config_keys: measure(file.config_keys, `${where}.config_keys`),
        import_edges: measure(file.import_edges, `${where}.import_edges`),
        assertions: measure(file.assertions, `${where}.assertions`),
        skip_markers: measure(file.skip_markers, `${where}.skip_markers`),
        timeout_changes: list(file.timeout_changes, `${where}.timeout_changes`).map((change, at) => ({
          name: text(change.name, `${where}.timeout_changes[${at}].name`),
          from_seconds: seconds(change.from_seconds, `${where}.timeout_changes[${at}].from_seconds`),
          to_seconds: seconds(change.to_seconds, `${where}.timeout_changes[${at}].to_seconds`),
        })),
        hunks: text(file.hunks, `${where}.hunks`),
      };
    }),
    duplicate_paths: list(input.duplicate_paths, "duplicate_paths").map((pair, index) => ({
      old: text(pair.old, `duplicate_paths[${index}].old`),
      new: text(pair.new, `duplicate_paths[${index}].new`),
    })),
    consumers: list(input.consumers, "consumers").map((observation, index) => ({
      consumer: text(observation.consumer, `consumers[${index}].consumer`),
      motif: text(observation.motif, `consumers[${index}].motif`),
      intended_facade: text(observation.intended_facade, `consumers[${index}].intended_facade`),
      bypassed_facade: flag(observation.bypassed_facade, `consumers[${index}].bypassed_facade`),
    })),
    thresholds: {
      lines: count(thresholds.lines, "thresholds.lines"),
      public_names: count(thresholds.public_names, "thresholds.public_names"),
      config_keys: count(thresholds.config_keys, "thresholds.config_keys"),
      import_edges: count(thresholds.import_edges, "thresholds.import_edges"),
      consumer_motifs: count(thresholds.consumer_motifs, "thresholds.consumer_motifs"),
    },
  };
}

// ---- signals ---------------------------------------------------------------------------------------------------

const DEFAULT_GROWTH_LINES = 150;
const DEFAULT_GROWTH_PUBLIC_NAMES = 5;
const DEFAULT_GROWTH_CONFIG_KEYS = 3;
const DEFAULT_GROWTH_IMPORT_EDGES = 3;
const DEFAULT_MOTIF_CONSUMERS = 3;
/** How many times a threshold growth must reach before it earns deeper review instead of a note. */
const ESCALATION_FACTOR = 2;

const orDefault = (value: number, fallback: number): number => (value <= 0 ? fallback : value);

/** Thresholds with every zero (or negative) entry replaced by its default. */
export function withDefaultThresholds(thresholds: QualityThresholds): QualityThresholds {
  return {
    lines: orDefault(thresholds.lines, DEFAULT_GROWTH_LINES),
    public_names: orDefault(thresholds.public_names, DEFAULT_GROWTH_PUBLIC_NAMES),
    config_keys: orDefault(thresholds.config_keys, DEFAULT_GROWTH_CONFIG_KEYS),
    import_edges: orDefault(thresholds.import_edges, DEFAULT_GROWTH_IMPORT_EDGES),
    consumer_motifs: orDefault(thresholds.consumer_motifs, DEFAULT_MOTIF_CONSUMERS),
  };
}

const growth = (measured: Measure): number => measured.after - measured.before;

/** Reaching a limit is a note; only reaching ESCALATION_FACTOR times the limit asks for deeper review. */
function growthFinding(scope: string, kind: SignalKind, unit: string, measured: Measure, limit: number): QualityFinding[] {
  const grown = growth(measured);
  if (grown < limit) return [];
  const deeper = grown >= limit * ESCALATION_FACTOR;
  return [
    {
      kind,
      triage: deeper ? "review" : "note",
      scope,
      evidence: `${unit} grew from ${measured.before} to ${measured.after} (+${grown}; report threshold ${limit})`,
      deeper_review: deeper,
    },
  ];
}

function markerFinding(scope: string, kind: SignalKind, present: boolean, evidence: string): QualityFinding[] {
  if (!present) return [];
  return [{ kind, triage: "review", scope, evidence, deeper_review: true }];
}

/** The signals one changed file raises: growth first, then (test files) assertions and skips, then timeouts. */
export function fileFindings(file: ChangedFile, limits: QualityThresholds): QualityFinding[] {
  const { path } = file;
  const out = [
    ...growthFinding(path, "file_growth", "lines", file.lines, limits.lines),
    ...growthFinding(path, "public_vocabulary_growth", "public names", file.public_names, limits.public_names),
    ...growthFinding(path, "configuration_growth", "configuration keys", file.config_keys, limits.config_keys),
    ...growthFinding(path, "import_edge_growth", "import edges", file.import_edges, limits.import_edges),
  ];
  if (file.test) {
    out.push(
      ...markerFinding(
        path,
        "assertion_reduction",
        growth(file.assertions) < 0,
        `assertions fell from ${file.assertions.before} to ${file.assertions.after}`,
      ),
      ...markerFinding(
        path,
        "skipped_test_added",
        growth(file.skip_markers) > 0,
        `skip markers rose from ${file.skip_markers.before} to ${file.skip_markers.after}`,
      ),
    );
  }
  for (const change of file.timeout_changes) {
    out.push(
      ...markerFinding(
        path,
        "timeout_widened",
        change.to_seconds > change.from_seconds,
        `timeout ${quote(change.name)} widened from ${formatFloat(change.from_seconds)}s to ${formatFloat(change.to_seconds)}s`,
      ),
    );
  }
  return out;
}

export function duplicatePathFinding(pair: DuplicatePathMarker): QualityFinding {
  return {
    kind: "duplicate_path",
    triage: "review",
    scope: pair.new,
    evidence: `caller marked old path ${quote(pair.old)} and new path ${quote(pair.new)} as coexisting`,
    deeper_review: true,
  };
}

/** Motifs repeated by at least `limit` distinct consumers, in first-seen order, consumers sorted. */
function repeatedMotifFindings(observations: readonly ConsumerObservation[], limit: number): QualityFinding[] {
  const consumersByMotif = new Map<string, string[]>();
  for (const observation of observations) {
    const motif = trimSpace(observation.motif);
    if (motif === "") continue;
    const consumers = consumersByMotif.get(motif) ?? [];
    if (!consumers.includes(observation.consumer)) consumers.push(observation.consumer);
    consumersByMotif.set(motif, consumers);
  }
  const out: QualityFinding[] = [];
  for (const [motif, seen] of consumersByMotif) {
    if (seen.length < limit) continue;
    const deeper = seen.length >= limit * ESCALATION_FACTOR;
    out.push({
      kind: "repeated_consumer_motif",
      triage: deeper ? "review" : "note",
      scope: motif,
      consumers: [...seen].sort(compareBytes),
      evidence: `${seen.length} consumers repeat motif ${quote(motif)} (report threshold ${limit}); a reviewer decides whether one abstraction would expose fewer concepts`,
      deeper_review: deeper,
    });
  }
  return out;
}

function facadeBypassFinding(observation: ConsumerObservation): QualityFinding {
  const facade = observation.intended_facade === "" ? "(intended facade not named)" : observation.intended_facade;
  return {
    kind: "facade_bypass",
    triage: "review",
    scope: observation.consumer,
    consumers: [observation.consumer],
    evidence: `consumer ${quote(observation.consumer)} bypassed intended facade ${facade}`,
    deeper_review: true,
  };
}

/** Repeated motifs, then facade bypasses: both prompt judgment about a missing or ignored abstraction. */
export function consumerFindings(observations: readonly ConsumerObservation[], limits: QualityThresholds): QualityFinding[] {
  return [
    ...repeatedMotifFindings(observations, limits.consumer_motifs),
    ...observations.filter((observation) => observation.bypassed_facade).map(facadeBypassFinding),
  ];
}

// ---- review request --------------------------------------------------------------------------------------------

/** Bounds the diff text carried per finding. */
const MAX_FINDING_HUNK_BYTES = 4000;
const HUNK_TRUNCATED_MARKER = "\n... (hunk truncated)";

const REVIEW_ID = "flagged_evidence";
const REVIEW_PROMPT = "Given only the flagged evidence, does the change's stated purpose explain it, or should a human look at it?";

const REVIEW_OPTIONS = [
  { id: "explained_by_change_purpose", meaning: "the change's stated purpose accounts for the flagged evidence" },
  { id: "needs_human_attention", meaning: "the flagged evidence is not explained and a human should look" },
  { id: "cannot_determine", meaning: "the evidence supplied cannot settle the question" },
] as const;

function boundedHunk(hunk: string): string {
  if (utf8Length(hunk) <= MAX_FINDING_HUNK_BYTES) return hunk;
  return utf8Prefix(hunk, MAX_FINDING_HUNK_BYTES) + HUNK_TRUNCATED_MARKER;
}

/** Each changed file's diff hunks keyed by path; a later file with the same path wins. */
function hunksByPath(files: readonly ChangedFile[]): Map<string, string> {
  const hunks = new Map<string, string>();
  for (const file of files) {
    if (file.hunks !== "") hunks.set(file.path, file.hunks);
  }
  return hunks;
}

/**
 * The review request for the findings that asked for deeper review, or undefined when none did. Nothing answers it:
 * this tool asks no model and has no reviewer, so the status is always `unresolved` (what the Go original reported
 * with no reviewer installed). The caller reads the request and judges the flagged evidence itself.
 */
export function unresolvedReview(
  findings: readonly QualityFinding[],
  purpose: string,
  files: readonly ChangedFile[],
): QualityReview | undefined {
  const hunks = hunksByPath(files);
  const flagged = findings
    .filter((finding) => finding.deeper_review)
    .map((finding): QualityFinding => {
      const hunk = boundedHunk(hunks.get(finding.scope) ?? "");
      return hunk === "" ? finding : { ...finding, hunk };
    });
  if (flagged.length === 0) return undefined;
  return {
    status: "unresolved",
    request: {
      id: REVIEW_ID,
      prompt: REVIEW_PROMPT,
      ...(purpose === "" ? {} : { purpose }),
      options: REVIEW_OPTIONS.map((option) => ({ ...option })),
      findings: flagged,
    },
  };
}

// ---- the assessment --------------------------------------------------------------------------------------------

export const CHANGE_QUALITY_BASIS = "deterministic signals from the supplied change description; review-triage evidence only";

/** Findings in order: each file in input order, then duplicate paths, repeated motifs and facade bypasses. */
export function assessChangeQuality(input: AssessChangeQualityInput): ChangeQualityAssessment {
  const limits = withDefaultThresholds(input.thresholds);
  const findings = [
    ...input.files.flatMap((file) => fileFindings(file, limits)),
    ...input.duplicate_paths.map(duplicatePathFinding),
    ...consumerFindings(input.consumers, limits),
  ];
  const review = unresolvedReview(findings, input.purpose, input.files);
  return {
    files_examined: input.files.length,
    findings,
    deeper_review: findings.some((finding) => finding.deeper_review),
    ...(review === undefined ? {} : { review }),
    basis: CHANGE_QUALITY_BASIS,
  };
}
