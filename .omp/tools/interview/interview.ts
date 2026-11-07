import { type Assessment, assess, type Breakdown, type Dimension, scoredDimensions } from "./ambiguity.js";
import { type Candidate, PERSONAS, selectCandidate } from "./candidates.js";
import { contextFor } from "./context.js";
import { askJson, type Exec, mapLimit, type ModelStep } from "./omp_model.js";
import { candidatePrompt, gradingPrompt, parseCandidate, parseGrading } from "./prompts.js";
import {
  answeredRounds,
  createSessionDirectory,
  loadSession,
  parseContext,
  type RepoContext,
  saveSession,
  type Session,
  sessionDirectory,
  type Status,
} from "./session.js";

/** Answered rounds before the first grading; nothing can be ready sooner (interview.py:57 MIN_ROUNDS_BEFORE_EARLY_EXIT). */
export const MIN_ROUNDS_BEFORE_SCORING = 3;

export interface InterviewInput {
  session_id?: string;
  idea?: string;
  answer?: string;
  cwd?: string;
  /** Name or id of an atask project whose home is the brownfield context. */
  project?: string;
  context?: unknown;
}

export interface InterviewOutput {
  session_id: string;
  status: Status;
  question?: string;
  target_dimension?: string;
  /** Rounds answered so far. */
  round: number;
  ambiguity?: number;
  breakdown?: Breakdown;
  milestone?: Assessment["milestone"];
  floor_failures: string[];
  brownfield: boolean;
  /** The session's directory in the central store. */
  store_dir: string;
}

export interface InterviewDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  exec: Exec;
  /** Where the caller stands; the brownfield check reads it when a new interview gives no `cwd`. */
  cwd: string;
  signal?: AbortSignal;
  now?: () => Date;
  home?: string;
}

const blank = (text: string | undefined): boolean => text === undefined || text.trim() === "";

/** Throws the first refusal a start or continue input earns. */
export function checkInput(input: InterviewInput): void {
  if (input.session_id === undefined) {
    if (blank(input.idea)) throw new Error("idea is required to start an interview");
    if (input.answer !== undefined) throw new Error("answer needs the session_id of the interview it answers");
    return;
  }
  if (blank(input.answer)) throw new Error("answer is required to continue an interview");
  if (input.idea !== undefined) throw new Error("idea starts a new interview; omit it when continuing session_id");
}

/** A new session held in memory; it reaches the store only once its first question exists. */
function startSession(idea: string, context: RepoContext | undefined, now: string): Session {
  return {
    version: 1,
    session_id: "",
    idea: idea.trim(),
    created_at: now,
    updated_at: now,
    brownfield: context !== undefined,
    ...(context === undefined ? {} : { context }),
    rounds: [],
    status: "asking",
  };
}

/** The stored session with the user's answer on its pending question. */
async function recordAnswer(sessionId: string, answer: string, now: string): Promise<Session> {
  const session = await loadSession(sessionId);
  if (session.status === "ready") {
    throw new Error(
      `interview ${sessionId} is already ready (ambiguity ${session.assessment?.ambiguity}): crystallize it with crystallize_spec`,
    );
  }
  const pending = session.rounds.at(-1);
  if (pending === undefined || pending.answer !== undefined) {
    throw new Error(`interview ${sessionId} has no pending question to answer`);
  }
  return {
    ...session,
    updated_at: now,
    rounds: [...session.rounds.slice(0, -1), { ...pending, answer: answer.trim() }],
  };
}

/** Grades the interview: one model call, every scored dimension at once. */
async function grade(session: Session, deps: InterviewDeps): Promise<Assessment> {
  const dimensions: Dimension[] = scoredDimensions(session.brownfield);
  const clarity = await askJson(deps.step, gradingPrompt(session, dimensions), (value) => parseGrading(value, dimensions), {
    signal: deps.signal,
  });
  return assess(clarity as Breakdown, session.brownfield);
}

/** One question per persona, concurrently. A persona that fails is dropped, as Ouroboros drops it (interview.py:1136-1149). */
async function proposeCandidates(
  session: Session,
  assessment: Assessment | undefined,
  deps: InterviewDeps,
): Promise<Candidate[]> {
  const proposed = await mapLimit(PERSONAS, PERSONAS.length, async (persona): Promise<Candidate | Error> => {
    try {
      return await askJson(deps.step, candidatePrompt(persona, session, assessment), (value) => parseCandidate(value, persona), {
        signal: deps.signal,
      });
    } catch (error) {
      deps.signal?.throwIfAborted();
      return new Error(`${persona}: ${(error as Error).message}`);
    }
  });
  const candidates = proposed.filter((result): result is Candidate => !(result instanceof Error));
  if (candidates.length === 0) {
    const reasons = proposed.map((result) => (result as Error).message).join("; ");
    throw new Error(`no persona proposed a question: ${reasons}`);
  }
  return candidates;
}

function outputOf(session: Session, assessment: Assessment | undefined): InterviewOutput {
  const pending = session.status === "asking" ? session.rounds.at(-1) : undefined;
  return {
    session_id: session.session_id,
    status: session.status,
    ...(pending === undefined ? {} : { question: pending.question, target_dimension: pending.target_dimension }),
    round: answeredRounds(session).length,
    ...(assessment === undefined
      ? {}
      : { ambiguity: assessment.ambiguity, breakdown: assessment.breakdown, milestone: assessment.milestone }),
    floor_failures: [...(assessment?.floor_failures ?? [])],
    brownfield: session.brownfield,
    store_dir: sessionDirectory(session.session_id),
  };
}

/** Saves the session, giving a new one its id and directory first. */
async function stored(session: Session): Promise<Session> {
  const saved = session.session_id === "" ? { ...session, session_id: await createSessionDirectory(session.idea) } : session;
  await saveSession(saved);
  return saved;
}

/**
 * One turn of a Socratic interview. Start with an idea; each answer is recorded, graded from round 3 on, and either
 * the gate opens (`ready`) or the persona panel asks the next question aimed at the least clear dimension.
 */
export async function runInterview(input: InterviewInput, deps: InterviewDeps): Promise<InterviewOutput> {
  checkInput(input);
  const now = (deps.now?.() ?? new Date()).toISOString();
  let session: Session;
  if (input.session_id === undefined) {
    const context = input.context !== undefined
      ? parseContext(input.context)
      : await contextFor(
        { cwd: blank(input.cwd) ? deps.cwd : input.cwd!, ...(blank(input.project) ? {} : { project: input.project!.trim() }) },
        deps.exec,
        deps.home,
        deps.signal,
      );
    session = startSession(input.idea!, context, now);
  } else {
    session = await recordAnswer(input.session_id, input.answer!, now);
  }
  const graded = input.session_id !== undefined && answeredRounds(session).length >= MIN_ROUNDS_BEFORE_SCORING;
  const assessment = graded ? await grade(session, deps) : session.assessment;
  if (assessment?.ready === true) {
    const ready = await stored({ ...session, assessment, status: "ready" });
    return outputOf(ready, assessment);
  }
  const candidates = await proposeCandidates(session, assessment, deps);
  const chosen = selectCandidate(candidates, assessment?.breakdown ?? {});
  const asking = await stored({
    ...session,
    ...(assessment === undefined ? {} : { assessment }),
    rounds: [...session.rounds, {
      question: chosen.question,
      target_dimension: chosen.target_dimension,
      persona: chosen.persona,
    }],
  });
  return outputOf(asking, assessment);
}
