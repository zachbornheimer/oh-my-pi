import type { Breakdown } from "./ambiguity.js";

export type OntologyFieldType = "string" | "number" | "boolean" | "array" | "object";
export const ONTOLOGY_FIELD_TYPES: readonly OntologyFieldType[] = ["string", "number", "boolean", "array", "object"];

export interface OntologyField {
  name: string;
  type: OntologyFieldType;
  description: string;
}

export interface Ontology {
  name: string;
  description: string;
  fields: OntologyField[];
}

/** What the model writes. Criteria get their ids from the code. */
export interface SeedReply {
  title: string;
  goal: string;
  constraints: string[];
  non_goals: string[];
  acceptance_criteria: { description: string; verify_command: string }[];
  ontology: Ontology;
  deferred: string[];
  open_questions: string[];
}

export interface AcceptanceCriterion {
  /** `AC-001`, `AC-002`, … in order. */
  id: string;
  description: string;
  verify_command?: string;
}

/** The seed's content: what agents build from. `sha256` in the metadata is over exactly this. */
export interface Seed {
  title: string;
  goal: string;
  constraints: string[];
  non_goals: string[];
  acceptance_criteria: AcceptanceCriterion[];
  ontology?: Ontology;
  deferred: string[];
  open_questions: string[];
}

export interface SeedMetadata {
  /** null when the interview was forced before its first grading. */
  ambiguity: number | null;
  breakdown: Breakdown;
  gate_forced: boolean;
  interview_session_id: string;
  /** 1 for seed.json, 2 for seed.v2.json, … */
  version: number;
  created_at: string;
  /** sha256 of the seed content (every field but metadata) as canonical JSON. */
  sha256: string;
}

export interface CrystallizeSpecInput {
  session_id: string;
  force?: boolean;
  repo?: string;
}

export interface CrystallizeSpecOutput {
  session_id: string;
  spec_path: string;
  seed_path: string;
  repo_spec_path?: string;
  ambiguity: number | null;
  gate_forced: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/** The seed reply's shape (the JSON schema the model was shown), checked field by field; the content rules are `seedOf`'s. */
export function parseSeedReply(value: unknown): SeedReply {
  const reply = isRecord(value) && isRecord(value.Seed) ? value.Seed : value;
  if (!isRecord(reply)) throw new Error("the reply must be a JSON object with the seed's fields");
  const criteria = reply.acceptance_criteria;
  if (!Array.isArray(criteria)) throw new Error("acceptance_criteria must be an array");
  const ontology = reply.ontology;
  if (!isRecord(ontology)) throw new Error("ontology must be an object { name, description, fields }");
  if (!Array.isArray(ontology.fields)) throw new Error("ontology.fields must be an array");
  return {
    title: text(reply.title, "title"),
    goal: text(reply.goal, "goal"),
    constraints: strings(reply.constraints, "constraints"),
    non_goals: strings(reply.non_goals, "non_goals"),
    acceptance_criteria: criteria.map((criterion, index) => {
      if (!isRecord(criterion)) throw new Error(`acceptance_criteria[${index}] must be an object`);
      return {
        description: text(criterion.description, `acceptance_criteria[${index}].description`),
        verify_command: text(criterion.verify_command, `acceptance_criteria[${index}].verify_command`),
      };
    }),
    ontology: {
      name: text(ontology.name, "ontology.name"),
      description: text(ontology.description, "ontology.description"),
      fields: ontology.fields.map((field: unknown, index: number) => {
        if (!isRecord(field)) throw new Error(`ontology.fields[${index}] must be an object`);
        const type = field.type;
        if (!ONTOLOGY_FIELD_TYPES.includes(type as OntologyFieldType)) {
          throw new Error(`ontology.fields[${index}].type must be one of ${ONTOLOGY_FIELD_TYPES.join(", ")}`);
        }
        return {
          name: text(field.name, `ontology.fields[${index}].name`),
          type: type as OntologyFieldType,
          description: text(field.description, `ontology.fields[${index}].description`),
        };
      }),
    },
    deferred: strings(reply.deferred, "deferred"),
    open_questions: strings(reply.open_questions, "open_questions"),
  };
}
