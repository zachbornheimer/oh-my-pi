import { createHash } from "node:crypto";
import type { Seed, SeedReply } from "./schemas.js";

/** JSON with object keys in sorted order at every depth, so equal values always give equal text. `undefined` members are left out, as `JSON.stringify` does. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  return sorted;
}

/** A constraint is one RFC 2119 requirement: "The system MUST …" (or MUST NOT, SHOULD, SHOULD NOT, MAY, SHALL). */
const REQUIREMENT = /^The system\b.*\b(MUST|SHALL|SHOULD|MAY)\b/;
/** Heredocs and line continuations do not survive a one-line criterion (seed-architect.md, `verify` semantics). */
const MULTILINE_COMMAND = /\n|<<|\\$/;
const ID_DIGITS = 3;
/** The longest title the seed prompt allows (its JSON schema's maxLength, which the source never enforced in code). */
export const TITLE_MAX_CHARS = 80;

function criterionId(index: number): string {
  return `AC-${String(index + 1).padStart(ID_DIGITS, "0")}`;
}

/** Every reason the model's seed cannot be kept, worded for the model to act on. */
function problemsOf(reply: SeedReply): string[] {
  const problems: string[] = [];
  if (reply.title.trim() === "") problems.push("title must not be blank");
  if (Array.from(reply.title.trim()).length > TITLE_MAX_CHARS) {
    problems.push(`title must be at most ${TITLE_MAX_CHARS} characters`);
  }
  if (reply.goal.trim() === "") problems.push("goal must not be blank");
  if (reply.acceptance_criteria.length === 0) problems.push("give at least one acceptance criterion");
  for (const constraint of reply.constraints) {
    if (!REQUIREMENT.test(constraint.trim())) {
      problems.push(
        `constraint ${
          JSON.stringify(constraint)
        } must start with "The system" and carry MUST, MUST NOT, SHOULD, SHOULD NOT or MAY in capitals`,
      );
    }
  }
  reply.acceptance_criteria.forEach((criterion, index) => {
    if (criterion.description.trim() === "") problems.push(`${criterionId(index)} needs a description`);
    if (MULTILINE_COMMAND.test(criterion.verify_command.trim())) {
      problems.push(`${criterionId(index)} verify_command must be one line with no heredoc or continuation`);
    }
  });
  return problems;
}

const trimmed = (lines: readonly string[]): string[] => lines.map((line) => line.trim()).filter((line) => line !== "");

/**
 * The seed the model wrote, trimmed and with its criteria numbered `AC-001`…; throws the reasons it is refused,
 * so `generate` shows them to the model and asks again. An ontology with no name is no ontology.
 */
export function seedOf(reply: SeedReply): Seed {
  const problems = problemsOf(reply);
  if (problems.length > 0) throw new Error(`fix the seed: ${problems.join("; ")}`);
  const ontology = reply.ontology.name.trim() === "" ? undefined : {
    name: reply.ontology.name.trim(),
    description: reply.ontology.description.trim(),
    fields: reply.ontology.fields,
  };
  return {
    title: reply.title.trim(),
    goal: reply.goal.trim(),
    constraints: trimmed(reply.constraints),
    non_goals: trimmed(reply.non_goals),
    acceptance_criteria: reply.acceptance_criteria.map((criterion, index) => {
      const command = criterion.verify_command.trim();
      return {
        id: criterionId(index),
        description: criterion.description.trim(),
        ...(command === "" ? {} : { verify_command: command }),
      };
    }),
    ...(ontology === undefined ? {} : { ontology }),
    deferred: trimmed(reply.deferred),
    open_questions: trimmed(reply.open_questions),
  };
}

/** sha256 of the seed content as canonical JSON (keys sorted at every depth). */
export function seedDigest(seed: Seed): string {
  return createHash("sha256").update(canonicalJson(seed)).digest("hex");
}
