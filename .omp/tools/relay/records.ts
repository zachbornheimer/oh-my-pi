import {
  type Improvement,
  IMPROVEMENTS,
  type PullRequestRef,
  type RewriteAnswer,
  ROOT_CAUSE_VERDICTS,
  type RootCauseVerdict,
  type Used,
  type WorkRecord,
  WORK_OUTCOMES,
} from "./types.js";

/**
 * Validators for the records a model writes, and the JSON Schema text each prompt shows. A validator answers the typed
 * record or throws a message naming the path that is wrong; it applies the same refinements the records always had
 * (a completed ticket carries evidence, a blocked one says what would unblock it).
 */

type Obj = Record<string, unknown>;

function fail(path: string, wanted: string, got: unknown): never {
  throw new Error(`${path}: expected ${wanted}, got ${got === undefined ? "nothing" : JSON.stringify(got)?.slice(0, 80)}`);
}

function object(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object", value);
  return value as Obj;
}

function str(value: unknown, path: string, min = 0): string {
  if (typeof value !== "string") fail(path, "a string", value);
  if ((value as string).length < min) fail(path, `a string of at least ${min} character`, value);
  return value as string;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean", value);
  return value as boolean;
}

function optionalStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function boolOr(value: unknown, path: string, fallback: boolean): boolean {
  return value === undefined ? fallback : bool(value, path);
}

function strings(value: unknown, path: string, minItem = 0): string[] {
  if (!Array.isArray(value)) fail(path, "an array of strings", value);
  return (value as unknown[]).map((item, index) => str(item, `${path}[${index}]`, minItem));
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path, `one of ${allowed.join(" | ")}`, value);
  return value as T;
}

function pullRequests(value: unknown, path: string): PullRequestRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "an array of pull request refs", value);
  return (value as unknown[]).map((item, index) => {
    const ref = object(item, `${path}[${index}]`);
    const number = ref.number;
    if (typeof number !== "number" || !Number.isInteger(number)) fail(`${path}[${index}].number`, "an integer", number);
    return {
      url: str(ref.url, `${path}[${index}].url`),
      org: str(ref.org, `${path}[${index}].org`),
      repo: str(ref.repo, `${path}[${index}].repo`),
      number: number as number,
    };
  });
}

function used(value: unknown, path: string): Used {
  const record = object(value, path);
  return {
    tools: strings(record.tools, `${path}.tools`),
    skills: strings(record.skills, `${path}.skills`),
    workflows: strings(record.workflows, `${path}.workflows`),
  };
}

export function parseRewriteAnswer(value: unknown, path = "Rewrite"): RewriteAnswer {
  const record = object(value, path);
  const answer = {
    decipherable: bool(record.decipherable, `${path}.decipherable`),
    description: str(record.description, `${path}.description`),
    questions: strings(record.questions, `${path}.questions`),
  };
  if (answer.decipherable && answer.description.trim() === "") {
    throw new Error(`${path}: a decipherable ticket needs its rewritten description`);
  }
  if (!answer.decipherable && answer.questions.length === 0) {
    throw new Error(`${path}: an undecipherable ticket needs the questions that block it`);
  }
  return answer;
}

/** The reply to the /tickets question: the record under the question's field name. */
export function parseRewriteReply(value: unknown, path = "reply"): RewriteAnswer {
  return parseRewriteAnswer(object(value, path).Rewrite, `${path}.Rewrite`);
}

export function parseRootCauseVerdict(value: unknown, path = "verdict"): RootCauseVerdict {
  const record = object(value, path);
  return {
    verdict: oneOf(record.verdict, `${path}.verdict`, ROOT_CAUSE_VERDICTS),
    workInThisCheckout: boolOr(record.workInThisCheckout, `${path}.workInThisCheckout`, true),
    rootCause: str(record.rootCause, `${path}.rootCause`),
    summary: str(record.summary, `${path}.summary`, 1),
    evidence: strings(record.evidence, `${path}.evidence`),
    concerns: strings(record.concerns, `${path}.concerns`),
    supersededBy: optionalStr(record.supersededBy, `${path}.supersededBy`),
    closeLinkedPullRequest: boolOr(record.closeLinkedPullRequest, `${path}.closeLinkedPullRequest`, false),
  };
}

export function parseWorkRecord(value: unknown, path = "work"): WorkRecord {
  const record = object(value, path);
  const answer: WorkRecord = {
    outcome: oneOf(record.outcome, `${path}.outcome`, WORK_OUTCOMES),
    summary: str(record.summary, `${path}.summary`, 1),
    used: used(record.used, `${path}.used`),
    concerns: strings(record.concerns, `${path}.concerns`),
    evidence: strings(record.evidence, `${path}.evidence`),
    supersededBy: optionalStr(record.supersededBy, `${path}.supersededBy`),
    closeLinkedPullRequest: boolOr(record.closeLinkedPullRequest, `${path}.closeLinkedPullRequest`, false),
    pullRequests: pullRequests(record.pullRequests, `${path}.pullRequests`),
  };
  if ((answer.outcome === "blocked" || answer.outcome === "needs_info") && answer.concerns.length === 0) {
    throw new Error(`${path}: a ${answer.outcome} answer needs the concern that says what is missing and what would unblock it`);
  }
  if (answer.outcome === "work_completed" && answer.evidence.length === 0) {
    throw new Error(`${path}: a completed ticket needs the evidence that its outcome was met`);
  }
  return answer;
}

export function parseImprovement(value: unknown, path = "improvement"): Improvement {
  const record = object(value, path);
  const answer: Improvement = {
    improvement: oneOf(record.improvement, `${path}.improvement`, IMPROVEMENTS),
    summary: str(record.summary, `${path}.summary`, 1),
    evidence: strings(record.evidence, `${path}.evidence`),
    pullRequests: pullRequests(record.pullRequests, `${path}.pullRequests`),
  };
  if (answer.improvement === "none" && answer.evidence.length > 0) {
    throw new Error(`${path}: a pass that found nothing missing changes nothing and carries no landing evidence`);
  }
  if (answer.improvement === "landed" && answer.evidence.length === 0) {
    throw new Error(`${path}: a landed tool names where it landed (a commit merged to main, or a pull request) in evidence`);
  }
  return answer;
}

// ── The JSON Schema each prompt shows the model ──────────────────────────────────────────────────────────────────

const strArray = { type: "array", items: { type: "string" } } as const;

const pullRequestRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "org", "repo", "number"],
  properties: {
    url: { type: "string" },
    org: { type: "string", description: "The GitHub organisation the repository is in." },
    repo: { type: "string", description: "The repository name, without the organisation." },
    number: { type: "integer" },
  },
} as const;

export const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decipherable", "description", "questions"],
  properties: {
    decipherable: { type: "boolean", description: "True when the ticket can be rewritten into the template without guessing." },
    description: { type: "string", description: "The whole rewritten ticket description in markdown; empty when decipherable is false." },
    questions: {
      type: "array",
      description: "What must be answered before development can start; empty when decipherable is true.",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export const ROOT_CAUSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "rootCause", "summary", "evidence", "concerns"],
  properties: {
    verdict: { type: "string", enum: [...ROOT_CAUSE_VERDICTS] },
    workInThisCheckout: { type: "boolean", default: true },
    rootCause: { type: "string" },
    summary: { type: "string", minLength: 1 },
    evidence: strArray,
    concerns: strArray,
    supersededBy: { type: "string" },
    closeLinkedPullRequest: { type: "boolean", default: false },
  },
} as const;

export const WORK_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "used", "concerns", "evidence"],
  properties: {
    outcome: { type: "string", enum: [...WORK_OUTCOMES] },
    summary: { type: "string", minLength: 1 },
    used: {
      type: "object",
      additionalProperties: false,
      required: ["tools", "skills", "workflows"],
      properties: { tools: strArray, skills: strArray, workflows: strArray },
    },
    concerns: strArray,
    evidence: strArray,
    supersededBy: { type: "string" },
    closeLinkedPullRequest: { type: "boolean", default: false },
    pullRequests: { type: "array", default: [], items: pullRequestRefSchema },
  },
} as const;

export const IMPROVEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["improvement", "summary", "evidence"],
  properties: {
    improvement: { type: "string", enum: [...IMPROVEMENTS] },
    summary: { type: "string", minLength: 1 },
    evidence: strArray,
    pullRequests: { type: "array", default: [], items: pullRequestRefSchema },
  },
} as const;

/** A JSON Schema as the text a prompt shows. */
export function schemaText(schema: object): string {
  return JSON.stringify(schema, null, 2);
}
