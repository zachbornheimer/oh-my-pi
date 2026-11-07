import { type Ask, decideNoul } from "./decide.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { ANSWER, type NoulQuestion, SEAM, STATE, TEST } from "./questions.js";
import type {
  Answer,
  Located,
  OrientOutput,
  OrientRequest,
  OrientScan,
  Probe,
  TestHit,
  TestWindow,
  Window,
} from "./schemas.js";

/**
 * Code orientation's judging half: every range the scan retrieved, read verbatim from disk at scan time, is verified
 * against the behavior by a model. The scan (`gather.ts`) retrieves; this file only judges and assembles the answer.
 * Read-only.
 */

/** A window at or above this probability is a verified hit. */
export const HIT_THRESHOLD = 0.5;

/**
 * Asks per model call. Each ask carries a range of up to 60 lines, so a call holding every range of a run dilutes the
 * model's attention; small calls, run at once, keep each range in focus.
 */
export const ASKS_PER_DECISION = 8;
/** Model calls in flight together. */
export const DECISIONS_IN_FLIGHT = 4;

export interface Judge {
  readonly step: ModelStep;
  readonly signal?: AbortSignal;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** Every ask answered as P(yes), in small model calls run a few at a time. */
async function judge(context: Judge, asks: readonly Ask[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const chunks = chunksOf(asks, ASKS_PER_DECISION);
  const answered = await mapLimit(chunks, DECISIONS_IN_FLIGHT, (chunk) => decideNoul(context.step, chunk, context.signal));
  for (const map of answered) for (const [field, score] of map) scores.set(field, score);
  return scores;
}

function rangeBody(label: string, query: string, path: string, window: Window): string {
  const numbered = window.text
    .split("\n")
    .map((line, index) => `${window.start + index}: ${line}`)
    .join("\n");
  return `${label}: ${query}\nRange: ${path}:${window.start}-${window.end}\n\n${numbered}`;
}

function located(path: string, window: Window, score: number): Located {
  return { path, start: window.start, end: window.end, score, evidence: window.evidence };
}

function ranked<T extends { score: number; path: string; start: number }>(hits: T[], limit: number): T[] {
  return hits
    .sort((one, other) => other.score - one.score || one.path.localeCompare(other.path) || one.start - other.start)
    .slice(0, limit);
}

/** Every retrieved range of the probe, with its file. */
function windowsOf(probe: Probe): { path: string; window: Window }[] {
  return probe.candidates.flatMap((candidate) => candidate.windows.map((window) => ({ path: candidate.path, window })));
}

interface BehaviorFacets {
  readonly seams: Located[];
  readonly state: Located[];
}

function ask(field: string, template: NoulQuestion, body: string): Ask {
  return { field, template, body };
}

/** Verifies every retrieved range as a seam and as state; a seam is not also listed as state. */
async function behaviorFacets(context: Judge, behavior: string, probe: Probe, limit: number): Promise<BehaviorFacets> {
  const windows = windowsOf(probe);
  const asks = windows.flatMap(({ path, window }, index) => [
    ask(`seam_${index}`, SEAM, rangeBody("Behavior", behavior, path, window)),
    ask(`state_${index}`, STATE, rangeBody("Behavior", behavior, path, window)),
  ]);
  const scores = await judge(context, asks);
  const seams: Located[] = [];
  const state: Located[] = [];
  windows.forEach(({ path, window }, index) => {
    const seam = scores.get(`seam_${index}`) ?? 0;
    const held = scores.get(`state_${index}`) ?? 0;
    if (seam >= HIT_THRESHOLD) seams.push(located(path, window, seam));
    else if (held >= HIT_THRESHOLD) state.push(located(path, window, held));
  });
  return { seams: ranked(seams, limit), state: ranked(state, limit) };
}

/** One answer per probe; every range of every question is judged in the same batch of model calls. */
async function answersFor(context: Judge, probes: readonly Probe[], limit: number): Promise<Answer[]> {
  const perProbe = probes.map((probe) => windowsOf(probe));
  const asks = probes.flatMap((probe, at) =>
    perProbe[at]!.map(({ path, window }, index) =>
      ask(`answer_${at}_${index}`, ANSWER, rangeBody("Question", probe.query, path, window))
    )
  );
  const scores = await judge(context, asks);
  return probes.map((probe, at) => {
    const hits = perProbe[at]!
      .map(({ path, window }, index) => located(path, window, scores.get(`answer_${at}_${index}`) ?? 0))
      .filter((hit) => hit.score >= HIT_THRESHOLD);
    const kept = ranked(hits, limit);
    return { question: probe.query, status: kept.length === 0 ? "not_found" : "found", hits: kept } as Answer;
  });
}

async function testHits(
  context: Judge,
  behavior: string,
  tests: readonly TestWindow[],
  limit: number,
): Promise<TestHit[]> {
  const asks = tests.map((test, index) =>
    ask(
      `test_${index}`,
      TEST,
      `${rangeBody("Behavior", behavior, test.path, test)}${test.name === null ? "" : `\nTest: ${test.name}`}`,
    )
  );
  const scores = await judge(context, asks);
  const hits = tests
    .map((test, index) => ({
      ...located(test.path, test, scores.get(`test_${index}`) ?? 0),
      name: test.name,
      gate: test.gate,
    }))
    .filter((hit) => hit.score >= HIT_THRESHOLD);
  return ranked(hits, limit);
}

/**
 * What an absence rests on. The model saw only the ranges retrieval ranked highest, so an absence is "none of those",
 * never "none in the repository"; keyword-only retrieval and partial coverage weaken it further.
 */
function basisOf(scan: OrientScan, probe: Probe): string {
  const count = probe.candidates.reduce((sum, candidate) => sum + candidate.windows.length, 0);
  const how = scan.retrieval.method === "fused" ? "embedding and keyword retrieval" : "keyword retrieval alone";
  const judged = `among the ${count} range${count === 1 ? "" : "s"} ${how} ranked highest`;
  return scan.truncated
    ? `${judged}; coverage partial: the listing stopped at the ${scan.fileCap}-file cap, so this absence is not proven`
    : `${judged}; coverage complete: ${scan.filesScanned} code files indexed`;
}

/** Each thing looked for and not found, with what the absence rests on. */
function absencesOf(
  scan: OrientScan,
  facets: BehaviorFacets,
  answers: readonly Answer[],
  tests: readonly TestHit[],
): string[] {
  const absences: string[] = [];
  if (facets.seams.length === 0) absences.push(`no range implements the behavior (${basisOf(scan, scan.behavior)})`);
  answers.forEach((answer, index) => {
    const probe = scan.questions[index] ?? { query: answer.question, candidates: [] };
    if (answer.status === "not_found") absences.push(`not found: ${answer.question} (${basisOf(scan, probe)})`);
  });
  if (tests.length === 0) {
    absences.push(`no test exercises the behavior among ${scan.testFilesScanned} test files scanned`);
  } else if (tests.every((test) => test.gate === null)) {
    const gap = scan.tests.find((test) => test.gateGap !== "")?.gateGap ?? "no runner found";
    absences.push(`no runnable gate: ${gap}`);
  }
  return absences;
}

/** Judges the scan and assembles the answer. Failure of any model step rejects the whole call. */
export async function judgeScan(request: OrientRequest, scan: OrientScan, context: Judge): Promise<OrientOutput> {
  const facets = await behaviorFacets(context, request.behavior, scan.behavior, request.limit);
  const answers = await answersFor(context, scan.questions, request.limit);
  const tests = await testHits(context, request.behavior, scan.tests, request.limit);
  const gate = tests.find((test) => test.gate !== null)?.gate ?? null;
  return {
    status: facets.seams.length === 0 ? "not_found" : "found",
    repo: request.repo,
    behavior: request.behavior,
    seams: facets.seams,
    state: facets.state,
    tests,
    gate,
    answers,
    absences: absencesOf(scan, facets, answers, tests),
    coverage: scan.truncated ? "partial" : "complete",
    filesScanned: scan.filesScanned,
    fileCap: scan.fileCap,
    truncated: scan.truncated,
    retrieval: scan.retrieval,
  };
}
