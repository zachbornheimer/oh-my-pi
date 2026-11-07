import type { Session } from "./session.js";
import type { Seed, SeedMetadata } from "./schemas.js";

/**
 * spec.md, rendered from the seed alone so the same seed always gives the same text. Headings follow GitHub
 * Spec Kit's spec template (`/speckit.plan` reads them): Feature Specification, User Scenarios & Testing,
 * Requirements (FR-001 …), Success Criteria; then Non-Goals, Assumptions & Deferred and the Interview Record.
 */

const NONE = "- None stated.";
const ID_DIGITS = 3;

/** Inline code that survives a backtick inside the text. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function bullets(lines: readonly string[]): string[] {
  return lines.length === 0 ? [NONE] : lines.map((line) => `- ${line}`);
}

function scenarioLines(seed: Seed): string[] {
  return seed.acceptance_criteria.map((criterion, index) =>
    `${index + 1}. **${criterion.id}**: ${criterion.description}`
  );
}

function requirementLines(seed: Seed): string[] {
  if (seed.constraints.length === 0) return [NONE];
  return seed.constraints.map((constraint, index) =>
    `- **FR-${String(index + 1).padStart(ID_DIGITS, "0")}**: ${constraint}`
  );
}

function entityLines(seed: Seed): string[] {
  if (seed.ontology === undefined) return [];
  return [
    "### Key Entities",
    "",
    `**${seed.ontology.name}**: ${seed.ontology.description}`,
    "",
    ...(seed.ontology.fields.length === 0
      ? [NONE]
      : seed.ontology.fields.map((field) => `- ${code(field.name)} (${field.type}): ${field.description}`)),
    "",
  ];
}

function successLines(seed: Seed): string[] {
  return seed.acceptance_criteria.flatMap((criterion) => [
    `- **${criterion.id}**: ${criterion.description}`,
    `  - Verify: ${criterion.verify_command === undefined ? "no command yet" : code(criterion.verify_command)}`,
  ]);
}

function recordLines(session: Session, metadata: SeedMetadata): string[] {
  const breakdown = Object.entries(metadata.breakdown).map(([dimension, clarity]) =>
    `${dimension} ${clarity.toFixed(2)}`
  );
  const failures = session.assessment?.floor_failures ?? [];
  const answered = session.rounds.filter((round) => round.answer !== undefined);
  return [
    `**Ambiguity**: ${metadata.ambiguity === null ? "not graded" : metadata.ambiguity.toFixed(2)}`,
    `**Clarity**: ${breakdown.length === 0 ? "not graded" : breakdown.join(", ")}`,
    `**Floor failures**: ${failures.length === 0 ? "none" : failures.join("; ")}`,
    `**Gate forced**: ${metadata.gate_forced ? "yes" : "no"}`,
    "",
    ...(answered.length === 0
      ? ["No questions were answered."]
      : answered.flatMap((round, index) => [`${index + 1}. **Q**: ${round.question}`, `   **A**: ${round.answer}`])),
  ];
}

/** The whole spec.md for one seed of one interview. */
export function specMarkdown(seed: Seed, metadata: SeedMetadata, session: Session): string {
  return [
    `# Feature Specification: ${seed.title}`,
    "",
    `**Interview**: ${code(session.session_id)}`,
    `**Created**: ${metadata.created_at}`,
    `**Status**: ${metadata.gate_forced ? "Draft (ambiguity gate forced)" : "Draft"}`,
    `**Input**: User description: "${session.idea}"`,
    "",
    "## User Scenarios & Testing",
    "",
    "### Primary User Story",
    "",
    seed.goal,
    "",
    "### Acceptance Scenarios",
    "",
    ...scenarioLines(seed),
    "",
    "## Requirements",
    "",
    "### Functional Requirements",
    "",
    ...requirementLines(seed),
    "",
    ...entityLines(seed),
    "## Success Criteria",
    "",
    "### Measurable Outcomes",
    "",
    ...successLines(seed),
    "",
    "## Non-Goals",
    "",
    ...bullets(seed.non_goals),
    "",
    "## Assumptions & Deferred",
    "",
    "### Deferred",
    "",
    ...bullets(seed.deferred),
    "",
    "### Open Questions",
    "",
    ...bullets(seed.open_questions),
    "",
    "## Interview Record",
    "",
    ...recordLines(session, metadata),
    "",
  ].join("\n");
}
