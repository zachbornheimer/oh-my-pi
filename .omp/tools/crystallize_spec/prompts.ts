import { assessmentText, contextText, type Session, transcriptText } from "./session.js";

/**
 * The seed-writing question, condensed from Ouroboros (MIT, see NOTICE.md; github.com/Q00/ouroboros @ 05d2718:
 * agents/seed-architect.md and the Seed model in core/seed.py). Constraints are RFC 2119 requirements so spec.md can
 * list them as GitHub Spec Kit functional requirements (FR-001: The system MUST ...).
 */
export const SEED_INSTRUCTIONS = `You transform an interview into an immutable seed specification: the constitution an agent will build from. Extract structured requirements from the idea and the transcript. Only what the idea or a recorded answer states may become a requirement; a question is not itself a decision, and nothing in a question line becomes a requirement on its own.

title: a short name for the feature (at most 80 characters).

goal: a clear, specific statement of the primary objective, such as "Build a CLI task management tool in Python".

constraints: the hard requirements the work must satisfy, each one sentence that starts with "The system" and states its force with an RFC 2119 keyword in capitals (MUST, MUST NOT, SHOULD, SHOULD NOT, MAY), such as "The system MUST work offline". Only what the idea or an answer states is a constraint.

non_goals: what the user ruled out of scope, each one sentence. [] when none was stated.

acceptance_criteria: specific, measurable criteria for success. Each names a state of the finished work that a user can see is true, not an implementation step: a criterion intelligible only as a move toward a sibling belongs merged into the outcome it serves. verify_command is exactly one single-line shell command that observes (never writes to) the workspace and decides the criterion: no heredoc or multiline syntax, never a bare whole-suite command such as "python -m pytest -q" (name the test file or test id instead). Write "" when no command can decide it yet.

ontology: the domain model of the work, with a name, a description, and its key fields (each with a name, a type of string, number, boolean, array or object, and a description). Write an empty name, description and fields when the work has no domain model.

deferred: points the user explicitly chose to decide later. These are intentional; list them, never turn them into requirements.

open_questions: points nobody decided that you would otherwise have to guess (a scope limit, a default, an exact value). Never put a guess in constraints or acceptance_criteria instead.

Be specific and concrete. Extract actual requirements from the interview, not generic placeholders.`;

/** The reply shape, as the JSON schema the Mastra question carried. */
export const SEED_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    goal: { type: "string", minLength: 1 },
    constraints: { type: "array", items: { type: "string", minLength: 1 } },
    non_goals: { type: "array", items: { type: "string", minLength: 1 } },
    acceptance_criteria: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: { description: { type: "string", minLength: 1 }, verify_command: { type: "string" } },
        required: ["description", "verify_command"],
        additionalProperties: false,
      },
    },
    ontology: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["string", "number", "boolean", "array", "object"] },
              description: { type: "string" },
            },
            required: ["name", "type", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "description", "fields"],
      additionalProperties: false,
    },
    deferred: { type: "array", items: { type: "string", minLength: 1 } },
    open_questions: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["title", "goal", "constraints", "non_goals", "acceptance_criteria", "ontology", "deferred", "open_questions"],
  additionalProperties: false,
} as const;

/** What the seed writer reads: the idea, the codebase, the latest grading and the whole interview. */
export function seedBrief(session: Session): string {
  return [
    `Idea: ${session.idea}`,
    `Project context: ${contextText(session.context)}`,
    `Ambiguity: ${assessmentText(session.assessment)}`,
    "Transcript:",
    transcriptText(session),
  ].join("\n");
}

/** The whole seed prompt: instructions, the interview, and the JSON schema the reply must match. */
export function seedPrompt(session: Session): string {
  return `## Seed\n${SEED_INSTRUCTIONS}\n\nPrompt:\n${seedBrief(session)}\n\nRespond with only a JSON object matching this JSON schema:\n${JSON.stringify(SEED_SCHEMA)}`;
}
