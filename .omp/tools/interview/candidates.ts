import { type Breakdown, type Dimension, DIMENSIONS } from "./ambiguity.js";

/**
 * The question panel, lifted from Ouroboros (MIT, see NOTICE.md): `src/ouroboros/bigbang/interview.py:613-725`.
 * Three personas each propose one question aimed at a dimension; a deterministic rule, not a judge, picks one.
 */

/** The personas in priority order, most preferred first (interview.py:623). */
export const PERSONAS = ["contrarian", "architect", "researcher"] as const;
export type Persona = (typeof PERSONAS)[number];

/**
 * Each persona's lens, condensed from its core instructions in `src/ouroboros/agents/{contrarian,architect,researcher}.md`.
 */
export const PERSONA_LENSES: Readonly<Record<Persona, string>> = {
  contrarian: "You question everything to uncover fundamental flaws in approach. "
    + "What everyone assumes is true, you examine; what seems obviously correct, you invert. "
    + "Surface the assumptions the idea takes for granted, consider the opposite of each, "
    + "ask whether this is the right problem at all, and what would happen if nothing were done.",
  architect: "You see problems as structural, not just tactical. "
    + "Ask about the core abstractions, where responsibilities overlap, where the coupling points and boundaries sit, "
    + "and what the smallest structure is that would hold the work without fighting it.",
  researcher: "You investigate when the problem is unclear: most blocks exist because information is missing. "
    + "Name what is still unknown, what evidence or documentation would settle it, "
    + "and which exact case or test would show the answer.",
};

/** One persona-proposed question; `target_dimension` is "" when the persona named no known dimension. */
export interface Candidate {
  readonly persona: Persona;
  readonly question: string;
  readonly target_dimension: Dimension | "";
}

/** A named dimension, or "" for one the panel does not know (interview.py:752-756 tolerates it rather than dropping the question). */
export function knownDimension(named: string): Dimension | "" {
  const trimmed = named.trim();
  return (DIMENSIONS as readonly string[]).includes(trimmed) ? trimmed as Dimension : "";
}

/**
 * The candidate aimed at the least clear dimension; ties go to persona priority, and a dimension with no clarity
 * (unknown, or not graded yet) ranks last (interview.py:647-684 `select_question_candidate`).
 * Before the first grading every dimension is ungraded, so the pick is by persona order alone.
 */
export function selectCandidate(candidates: readonly Candidate[], clarity: Breakdown): Candidate {
  if (candidates.length === 0) throw new Error("candidates must not be empty");
  const rank = (candidate: Candidate): readonly [number, number] => [
    candidate.target_dimension === "" ? Infinity : clarity[candidate.target_dimension] ?? Infinity,
    PERSONAS.indexOf(candidate.persona),
  ];
  return candidates.reduce((best, candidate) => {
    const [clarityOfCandidate, priorityOfCandidate] = rank(candidate);
    const [clarityOfBest, priorityOfBest] = rank(best);
    const better = clarityOfCandidate < clarityOfBest
      || (clarityOfCandidate === clarityOfBest && priorityOfCandidate < priorityOfBest);
    return better ? candidate : best;
  });
}
