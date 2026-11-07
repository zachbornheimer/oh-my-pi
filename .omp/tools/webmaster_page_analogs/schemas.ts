import type { ContentMeasurement, PerformanceMeasurement, SeoMeasurement } from "./measurement.ts";
import type { Zod } from "./zod_type.ts";

// -- purpose ----------------------------------------------------------------------------------------------------

export const INTENT_CLASSES = ["inform", "honor", "convert", "navigate", "collect", "sell"] as const;
export const NOT_AUDITABLE = "not auditable";

/** The PAGE PURPOSE stage: what the page appears to exist to accomplish, judged from the measured page. */
export interface PagePurpose {
  purpose: string;
  intentClass: (typeof INTENT_CLASSES)[number] | "not auditable";
  primaryAudience: string;
  primaryAction: string | null;
  evidence: string[];
}

export interface PurposeResult extends PagePurpose {
  url: string;
  unmeasured?: string;
}

// -- sections ---------------------------------------------------------------------------------------------------

export const SERVES_PURPOSE = ["yes", "partially", "no", "unclear"] as const;

/** One major visually or semantically distinct section of the page, top to bottom. */
export interface AuditSection {
  ordinal: number;
  name: string;
  content: string;
  goal: string;
  servesPurpose: (typeof SERVES_PURPOSE)[number];
  note: string | null;
}

export interface SectionsResult {
  url: string;
  sections: AuditSection[];
  unmeasured?: string;
}

// -- interpretation ---------------------------------------------------------------------------------------------

/** One measured fact and what it means for this page's apparent purpose. */
export interface AuditFinding {
  measurement: string;
  consequence: string;
}

/** The most judgment findings one interpretation carries. */
export const FINDING_CAP = 8;

export interface InterpretationResult {
  url: string;
  findings: AuditFinding[];
  unmeasured?: string;
}

// -- analogs ----------------------------------------------------------------------------------------------------

/** The two analog sets: best-in-class pages in the target's industry, and pages elsewhere that solve the same intent. */
export const ANALOG_SETS = ["sameIndustry", "differentIndustry"] as const;
export type AnalogSet = (typeof ANALOG_SETS)[number];

/** A set smaller than this is reported short, never padded. */
export const ANALOG_SET_MIN = 3;
/** The most analogs one set keeps. */
export const ANALOG_SET_MAX = 5;
/** The most searches one queries answer writes for a set. */
export const QUERIES_PER_SET_MAX = 5;
/** The most characters of an analog's visible text its content measurement keeps. */
export const ANALOG_TEXT_CAP = 2_000;

export interface AnalogQueries {
  industry: string;
  sameIndustry: string[];
  differentIndustry: string[];
}

/** One analog as the choose step names it, from a page fetched in this run. */
export interface AnalogChoice {
  url: string;
  organization: string;
  industry: string;
  whyAnalogous: string;
  observedTitle: string;
  standoutPattern: string;
}

export interface RejectedCandidate {
  url: string;
  reason: string;
}

/** The choose step's answer, before validation. */
export interface AnalogAnswer {
  sameIndustry: AnalogChoice[];
  differentIndustry: AnalogChoice[];
  rejected: RejectedCandidate[];
}

export interface Analog extends AnalogChoice {
  measurements: { seo: SeoMeasurement; content: ContentMeasurement; performance: PerformanceMeasurement };
}

export interface AnalogsResult {
  url: string;
  industry: string;
  sameIndustry: Analog[];
  differentIndustry: Analog[];
  rejected: RejectedCandidate[];
  shortfalls: { set: AnalogSet; kept: number; minimum: number }[];
  unmeasured?: string;
}

// -- synthesis --------------------------------------------------------------------------------------------------

/** Where a pattern's evidence comes from: this page, a supplied analog, a named outside example, or several combined. */
export const EVIDENCE_CLASSES = ["CURRENT", "REMOTE", "EXTERNAL", "SYNTHESIS"] as const;
/** The fewest UI, UX and content patterns one synthesis names. */
export const PATTERN_MIN = 3;

export interface Pattern {
  behavior: string;
  evidence_class: (typeof EVIDENCE_CLASSES)[number];
  why_it_matters: string;
  current_comparison: string;
  analog_index: number | null;
  source: string | null;
}

export interface SynthesisAnswer {
  page_intent: string;
  intent_rationale: string;
  purpose: string;
  current: { summary: string; findings: string[] };
  remote: {
    analogs: { analog_index: number; behaviors: string[]; contrast_with_current: string }[];
    recurring_patterns: string[];
  };
  external: { name: string; url: string; source: string; behaviors: string[] }[];
  patterns: { ui: Pattern[]; ux: Pattern[]; content: Pattern[]; seo: Pattern[] };
  world_class: { common: string[]; strong: string[]; contextual: string[] };
  recommendations: { condition: string; evidence: string; implication: string }[];
  seo_recommendations: {
    title?: string;
    meta_description?: string;
    header_outline?: { level: number; text: string }[];
    schema_types?: string[];
    primary_keywords?: string[];
    secondary_keywords?: string[];
  };
  synthesis: { current: string; remote: string; world_class: string; implication: string };
}

export type SynthesisResult = ({ url: string } & SynthesisAnswer) | { url: string; unmeasured: string };

// -- reply validators --------------------------------------------------------------------------------------------

/** The validators for what a judgment model answers, built on `pi.zod`; each throws a message the model is shown on a retry. */
export function replySchemas(z: Zod) {
  const text = z.string().min(1);
  const purpose = z.object({
    purpose: text,
    intentClass: z.enum([...INTENT_CLASSES, "not auditable"]),
    primaryAudience: text,
    primaryAction: z.string().nullable(),
    evidence: z.array(text).max(3),
  });
  const section = z.object({
    ordinal: z.number().int().min(1),
    name: text,
    content: text,
    goal: text,
    servesPurpose: z.enum(SERVES_PURPOSE),
    note: z.string().nullable(),
  });
  const finding = z.object({ measurement: text, consequence: text });
  const choice = z.object({
    url: text,
    organization: text,
    industry: text,
    whyAnalogous: text,
    observedTitle: text,
    standoutPattern: text,
  });
  const pattern = z.object({
    behavior: text,
    evidence_class: z.enum(EVIDENCE_CLASSES),
    why_it_matters: text,
    current_comparison: text,
    analog_index: z.number().int().nullable(),
    source: z.string().nullable(),
  });
  return {
    purpose,
    sections: z.array(section),
    findings: z.array(finding).max(FINDING_CAP),
    queries: z.object({
      industry: text,
      sameIndustry: z.array(text).min(1).max(QUERIES_PER_SET_MAX),
      differentIndustry: z.array(text).min(1).max(QUERIES_PER_SET_MAX),
    }),
    followUp: z.object({ queries: z.array(text).min(1).max(QUERIES_PER_SET_MAX) }),
    analogAnswer: z.object({
      sameIndustry: z.array(choice).max(ANALOG_SET_MAX),
      differentIndustry: z.array(choice).max(ANALOG_SET_MAX),
      rejected: z.array(z.object({ url: z.string(), reason: text })),
    }),
    synthesis: z.object({
      page_intent: text,
      intent_rationale: text,
      purpose: text,
      current: z.object({ summary: text, findings: z.array(text) }),
      remote: z.object({
        analogs: z.array(z.object({
          analog_index: z.number().int(),
          behaviors: z.array(text),
          contrast_with_current: text,
        })),
        recurring_patterns: z.array(text),
      }),
      external: z.array(z.object({ name: text, url: text, source: text, behaviors: z.array(text) })),
      patterns: z.object({
        ui: z.array(pattern).min(PATTERN_MIN),
        ux: z.array(pattern).min(PATTERN_MIN),
        content: z.array(pattern).min(PATTERN_MIN),
        seo: z.array(pattern),
      }),
      world_class: z.object({ common: z.array(text), strong: z.array(text), contextual: z.array(text) }),
      recommendations: z.array(z.object({ condition: text, evidence: text, implication: text })),
      seo_recommendations: z.object({
        title: text.optional(),
        meta_description: text.optional(),
        header_outline: z.array(z.object({ level: z.number().int().min(1).max(6), text })).optional(),
        schema_types: z.array(text).optional(),
        primary_keywords: z.array(text).optional(),
        secondary_keywords: z.array(text).optional(),
      }),
      synthesis: z.object({ current: text, remote: text, world_class: text, implication: text }),
    }),
  };
}
