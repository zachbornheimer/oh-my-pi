import { type Assessment, type Dimension, DIMENSIONS } from "./ambiguity.js";
import { type Candidate, knownDimension, PERSONA_LENSES, type Persona } from "./candidates.js";
import { assessmentText, contextText, type Session, transcriptText } from "./session.js";

/**
 * What the model is asked, from the Ouroboros-derived question text the Mastra capability sent to its decision and
 * language models (github.com/Q00/ouroboros @ 05d2718, see NOTICE.md). Mastra graded with TypeSafe Jev, which answers
 * a five-level score question with calibrated probabilities; here the model states the level itself.
 */

/** The highest level of a grading question; clarity = level / MAX_LEVEL. */
export const MAX_LEVEL = 4;

const DEFERRAL =
  'IMPORTANT: if the transcript lists "decide-later" or "deferred" items, these are INTENTIONAL deferrals: the user has deliberately chosen to postpone those decisions. Do NOT lower the score for intentionally deferred items. Score only what is present and answerable. The top two levels require very specific requirements.';

interface Rubric {
  readonly instructions: string;
  /** Level 0 (lowest) to level 4 (highest). */
  readonly levels: readonly string[];
}

const ANALYST = "You are an expert requirements analyst grading how clear a software idea";

export const RUBRICS: Readonly<Record<Dimension, Rubric>> = {
  goal_clarity: {
    instructions: `${ANALYST} has become over an interview. Goal Clarity: Is the goal specific and well-defined? Read the idea and every answer in the transcript together. ${DEFERRAL}`,
    levels: [
      "Unclear. No goal can be told from the idea or the answers.",
      "Vague. A direction is named but not what will exist when it is done.",
      "Partially specified. The outcome is named but its scope or user is still open.",
      "Mostly specific. The outcome, its user and its scope are stated; only minor details are open.",
      "Perfectly specific. The goal is stated so exactly that two builders would build the same thing.",
    ],
  },
  constraint_clarity: {
    instructions: `${ANALYST} has become over an interview. Constraint Clarity: Are constraints and limitations specified? Read the idea and every answer in the transcript together. ${DEFERRAL}`,
    levels: [
      "Unclear. No constraint, limit or non-goal is stated.",
      "Vague. Constraints are hinted at but none is stated as a rule.",
      "Partially specified. Some constraints are stated; important limits or non-goals are still open.",
      "Mostly specific. The technical and scope limits and the non-goals are stated; only minor ones are open.",
      "Perfectly specific. Every constraint and non-goal that bounds the work is stated as a checkable rule.",
    ],
  },
  success_criteria_clarity: {
    instructions: `${ANALYST} has become over an interview. Success Criteria Clarity: Are success criteria measurable? Read the idea and every answer in the transcript together. ${DEFERRAL}`,
    levels: [
      "Unclear. Nothing says how anyone would know the work is done.",
      'Vague. Success is described in words like "works well" that no check could decide.',
      "Partially specified. Some outcomes are observable; others cannot yet be checked.",
      "Mostly specific. Most outcomes are measurable or checkable by a named test or command.",
      "Perfectly specific. Every success criterion is measurable and says how it is verified.",
    ],
  },
  context_clarity: {
    instructions: `You are an expert requirements analyst grading how clear a software idea about an existing codebase has become over an interview. Context Clarity: Is the existing codebase context clear? Are referenced codebases, patterns, and conventions well understood? Read the project context, the idea and every answer in the transcript together. ${DEFERRAL}`,
    levels: [
      "Unclear. Nothing says which parts of the codebase the work touches.",
      "Vague. The codebase is named but not the parts, patterns or conventions involved.",
      "Partially specified. The parts touched are named; the patterns to follow are still open.",
      "Mostly specific. The parts touched and the patterns and conventions to follow are stated.",
      "Perfectly specific. Every codebase, module, pattern and convention the work relies on is named.",
    ],
  },
};

/** The text the grading model reads: one rubric per dimension, the interview, and the JSON reply to give. */
export function gradingPrompt(session: Session, dimensions: readonly Dimension[]): string {
  const rubrics = dimensions.map((dimension) => {
    const { instructions, levels } = RUBRICS[dimension];
    const scale = levels.map((text, level) => `  ${level}: ${text}`).join("\n");
    return `## ${dimension}\n${instructions}\nLevels, lowest first:\n${scale}`;
  });
  const reply = `{${dimensions.map((dimension) => `"${dimension}": <number 0 to ${MAX_LEVEL}>`).join(", ")}}`;
  return [
    "Grade this software idea's interview on each dimension below.",
    "",
    ...rubrics.flatMap((rubric) => [rubric, ""]),
    "Idea:",
    session.idea,
    ...(session.context === undefined ? [] : ["", "Project context:", contextText(session.context)]),
    "",
    "Interview transcript:",
    transcriptText(session),
    "",
    `Reply with only a JSON object giving each dimension a level from 0 to ${MAX_LEVEL}. A level may carry one decimal to sit between two levels.`,
    `Respond as JSON matching this shape: ${reply}`,
  ].join("\n");
}

/** The levels the model gave, as clarity per dimension (level / MAX_LEVEL); throws when one is missing or off the scale. */
export function parseGrading(value: unknown, dimensions: readonly Dimension[]): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the reply must be a JSON object with one level per dimension");
  }
  const record = value as Record<string, unknown>;
  const clarity: Record<string, number> = {};
  for (const dimension of dimensions) {
    const level = record[dimension];
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > MAX_LEVEL) {
      throw new Error(`${dimension} must be a number from 0 to ${MAX_LEVEL}, got ${JSON.stringify(level)}`);
    }
    clarity[dimension] = level / MAX_LEVEL;
  }
  return clarity;
}

/** The interviewer contract, verbatim from the Ouroboros question prompt (interview.py:100-121). */
const INTERVIEWER = `## Role Boundaries
- You are only an interviewer.
- Generate exactly one Socratic question that reduces requirements ambiguity.
- Do not explore files, commands, repositories, APIs, tools, or external systems.
- Do not ask to inspect implementation details unless the caller already supplied those details.
- The caller supplies any code or research context in answers.

## Response Format
- Ask one focused question in 1-2 sentences.
- Do not include a preamble.
- End with the question.

## Questioning Strategy
- Target the biggest unresolved decision.
- Prefer scope, non-goal, success criteria, ownership, risk, and verification questions.
- For brownfield work, focus on intent and decisions rather than discovering what exists.

Response contract: emit exactly ONE question and end with it. Never announce implementation work — another agent does that later.

Propose ONE clarifying question through the persona lens given below, aimed at the single ambiguity dimension you judge weakest. Do not repeat a question the transcript already asked.`;

/** What one persona reads to propose the next question. */
export function candidatePrompt(persona: Persona, session: Session, assessment: Assessment | undefined): string {
  const brief = [
    `## Persona Lens: ${persona}`,
    PERSONA_LENSES[persona],
    "",
    `Idea: ${session.idea}`,
    `Project context: ${contextText(session.context)}`,
    `Ambiguity so far: ${assessmentText(assessment)}`,
    "Transcript:",
    transcriptText(session),
  ].join("\n");
  const shape = `{"question": "<one question>", "target_dimension": "<${DIMENSIONS.join(" | ")}>"}`;
  return `## QuestionCandidate\n${INTERVIEWER}\n\nPrompt:\n${brief}\n\nRespond as JSON matching this shape: ${shape}`;
}

/** A persona's reply as a candidate; throws on a blank question. An unknown dimension is kept as "" (Ouroboros tolerates it). */
export function parseCandidate(value: unknown, persona: Persona): Candidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the reply must be a JSON object { question, target_dimension }");
  }
  const { question, target_dimension: target } = value as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") throw new Error("question must not be blank");
  return {
    persona,
    question: question.trim(),
    target_dimension: knownDimension(typeof target === "string" ? target : ""),
  };
}
