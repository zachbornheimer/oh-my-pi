import type { Asset } from "./asset.ts";
import { type SecurityFinding, SEVERITIES, type Severity } from "./check.ts";
import { type Fact, FACTS, isFact, MAX_PACKAGES, PACKAGE_NAME } from "./inventory_facts.ts";

/**
 * The shapes the risk check reads and returns, and the checks the model's two replies must pass. Port of Mastra's
 * `webmaster.security.risk_check` schemas; the zod schemas become plain guards that name the offending field.
 */

export const SOURCE_KINDS = ["page", "nvd", "osv", "distro", "search_result"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const RESULTS = ["met", "not_met", "unknown"] as const;
export const VERDICTS = ["affected", "not_affected", "unmeasured", "not_applicable"] as const;
export const ASSET_KINDS = ["server", "site"] as const;

/** One thing read about the advisory: a page, a CVE record, a search result. */
export interface AdvisorySource {
  /** Where it was read. */
  url: string;
  kind: (typeof SOURCE_KINDS)[number];
  /** The HTTP status answered; 0 when nothing arrived. */
  status: number;
  /** The readable text kept, empty when nothing arrived. */
  text: string;
  error?: string;
}

/** A thing that must hold (or may hold) for an asset to be hurt, phrased so a fact can settle it. */
export interface Condition {
  id: string;
  statement: string;
  facts: Fact[];
  /** True when the asset is not affected unless this holds. */
  necessary: boolean;
}

export interface Component {
  name: string;
  package_names: string[];
  affected: string;
  fixed_in: string | null;
}

/** What the research found, in the words the checks use: components, conditions and the facts that settle them. */
export interface AdvisoryProfile {
  title: string;
  summary: string;
  severity: Severity;
  cves: string[];
  applies_to: Asset["kind"][];
  components: Component[];
  conditions: Condition[];
  compromise_indicators: string[];
  workaround: string[];
  remediation: string[];
  confidence: (typeof CONFIDENCES)[number];
  gaps: string[];
}

export type ResultKind = (typeof RESULTS)[number];

/** What the model says about one condition on one asset: the result and the fact line that shows it. */
export interface ConditionResult {
  condition: string;
  result: ResultKind;
  fact: Fact | null;
  quote: string;
  note: string;
}

export type Verdict = (typeof VERDICTS)[number];

export interface AssetVerdict {
  /** `server:<name>` or `site:<name>`. */
  asset: string;
  verdict: Verdict;
  reason: string;
  conditions: ConditionResult[];
}

export interface VerdictCounts {
  affected: number;
  not_affected: number;
  unmeasured: number;
  not_applicable: number;
}

export interface RiskCheckResult {
  advisory: AdvisoryProfile;
  sources: Omit<AdvisorySource, "text">[];
  headline: string;
  counts: VerdictCounts;
  assets: AssetVerdict[];
  findings: SecurityFinding[];
  unmeasured: { asset: string; reason: string }[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string, minLength = 0): string {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  if (value.length < minLength) throw new Error(`${where}: expected a non-empty string`);
  return value;
}

function strings(value: unknown, where: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array of strings`);
  return value.map((item, index) => {
    const each = text(item, `${where}[${index}]`);
    if (pattern !== undefined && !pattern.test(each)) throw new Error(`${where}[${index}]: "${each}" does not match ${pattern}`);
    return each;
  });
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${where}: expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function record(value: unknown, where: string): Json {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  return value;
}

const CVE_ID = /^CVE-\d{4}-\d{4,}$/;
const CONDITION_ID = /^[a-z][a-z0-9_]{0,40}$/;

function conditionOf(value: unknown, where: string): Condition {
  const each = record(value, where);
  const facts = each["facts"];
  if (!Array.isArray(facts) || facts.length === 0) throw new Error(`${where}.facts: expected at least one fact`);
  if (typeof each["necessary"] !== "boolean") throw new Error(`${where}.necessary: expected true or false`);
  const id = text(each["id"], `${where}.id`);
  if (!CONDITION_ID.test(id)) throw new Error(`${where}.id: "${id}" must be a short lowercase word with digits and underscores`);
  return {
    id,
    statement: text(each["statement"], `${where}.statement`, 1),
    facts: facts.map((fact, index) => {
      if (typeof fact !== "string" || !isFact(fact)) throw new Error(`${where}.facts[${index}]: expected one of ${FACTS.join(", ")}`);
      return fact;
    }),
    necessary: each["necessary"],
  };
}

function componentOf(value: unknown, where: string): Component {
  const each = record(value, where);
  const packages = strings(each["package_names"], `${where}.package_names`, PACKAGE_NAME);
  if (packages.length > MAX_PACKAGES) throw new Error(`${where}.package_names: at most ${MAX_PACKAGES}`);
  const fixed = each["fixed_in"];
  if (fixed !== null && typeof fixed !== "string") throw new Error(`${where}.fixed_in: expected a string or null`);
  return {
    name: text(each["name"], `${where}.name`, 1),
    package_names: packages,
    affected: text(each["affected"], `${where}.affected`),
    fixed_in: fixed,
  };
}

/** The model's `Profile` reply as a profile. Throws, naming the field, when the reply is not one. */
export function parseProfileReply(value: unknown): AdvisoryProfile {
  const wrapper = record(value, "reply");
  const profile = record(wrapper["Profile"], "Profile");
  const conditions = profile["conditions"];
  const components = profile["components"];
  if (!Array.isArray(conditions) || conditions.length === 0) throw new Error("Profile.conditions: expected at least one condition");
  if (!Array.isArray(components)) throw new Error("Profile.components: expected an array");
  const appliesTo = profile["applies_to"];
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) throw new Error("Profile.applies_to: expected at least one of server, site");
  return {
    title: text(profile["title"], "Profile.title", 1),
    summary: text(profile["summary"], "Profile.summary", 1),
    severity: oneOf(profile["severity"], SEVERITIES, "Profile.severity"),
    cves: strings(profile["cves"], "Profile.cves", CVE_ID),
    applies_to: appliesTo.map((kind, index) => oneOf(kind, ASSET_KINDS, `Profile.applies_to[${index}]`)),
    components: components.map((component, index) => componentOf(component, `Profile.components[${index}]`)),
    conditions: conditions.map((condition, index) => conditionOf(condition, `Profile.conditions[${index}]`)),
    compromise_indicators: strings(profile["compromise_indicators"], "Profile.compromise_indicators"),
    workaround: strings(profile["workaround"], "Profile.workaround"),
    remediation: strings(profile["remediation"], "Profile.remediation"),
    confidence: oneOf(profile["confidence"], CONFIDENCES, "Profile.confidence"),
    gaps: strings(profile["gaps"], "Profile.gaps"),
  };
}

/** The model's `Conditions` reply as results, one per element. Throws, naming the field, when it is not one. */
export function parseConditionsReply(value: unknown): ConditionResult[] {
  const wrapper = record(value, "reply");
  const results = wrapper["Conditions"];
  if (!Array.isArray(results)) throw new Error("Conditions: expected an array");
  return results.map((item, index) => {
    const where = `Conditions[${index}]`;
    const each = record(item, where);
    const fact = each["fact"];
    if (fact !== null && (typeof fact !== "string" || !isFact(fact))) {
      throw new Error(`${where}.fact: expected null or one of ${FACTS.join(", ")}`);
    }
    return {
      condition: text(each["condition"], `${where}.condition`),
      result: oneOf(each["result"], RESULTS, `${where}.result`),
      fact: fact as Fact | null,
      quote: text(each["quote"], `${where}.quote`),
      note: text(each["note"], `${where}.note`),
    };
  });
}

/** Worst severity first; ties keep their order. */
export const bySeverity = (a: Pick<SecurityFinding, "severity">, b: Pick<SecurityFinding, "severity">): number =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
