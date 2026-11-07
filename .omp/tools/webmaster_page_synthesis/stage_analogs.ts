import { type Candidate, candidatesFrom, fetchedOrRejected, type FetchedPage, type SearchHit } from "./candidates.ts";
import { askLanguage, languageNamed } from "./language.ts";
import { candidatesGround, measuredGroundTruth, purposeGround } from "./measured_brief.ts";
import { type PerformanceMeasurement, unmeasured } from "./measurement.ts";
import { mapLimit } from "./omp_model.ts";
import type { LanguageQuestion, QuestionFile } from "./questions.ts";
import {
  afterRound,
  type AnalogPool,
  EMPTY_POOL,
  FOLLOW_UP_ROUNDS,
  followUpGround,
  keptGround,
  type QueriesBySet,
  shortSets,
  untriedBySet,
} from "./rounds.ts";
import {
  type Analog,
  ANALOG_SET_MIN,
  ANALOG_SETS,
  ANALOG_TEXT_CAP,
  type AnalogAnswer,
  type AnalogSet,
  type AnalogsResult,
  type PagePurpose,
  type RejectedCandidate,
  replySchemas,
} from "./schemas.ts";
import type { SiteContext } from "./site_context.ts";
import type { Probes, StageEnv } from "./stage_types.ts";
import { type KeptChoice, validateChoices } from "./validate.ts";
import type { WebSearch } from "./web_search.ts";
import type { MeasuredAreas } from "./measured_brief.ts";

/** Results asked of each search. */
export const RESULTS_PER_QUERY = 6;
const SEARCHES_AT_ONCE = 4;
const FETCHES_AT_ONCE = 6;
/** Speed runs are heavy (PageSpeed quota, or a local Chrome each), so few run at once. */
const SPEED_RUNS_AT_ONCE = 2;

/** The typed answer when no analog search could run: both sets empty and the reason. */
export function analogsUnmeasured(url: string, reason: string): AnalogsResult {
  return { url, industry: "", sameIndustry: [], differentIndustry: [], rejected: [], shortfalls: [], unmeasured: reason };
}

/** What the analog stage reads besides the model: the target's probes, the search and the other pages' probes. */
export interface AnalogDeps {
  readonly probes: Pick<Probes, "seo" | "content" | "performance">;
  readonly search: WebSearch;
}

/** One round's search results by the set whose query found them, and every search that failed. */
interface Searched {
  readonly hits: Readonly<Record<AnalogSet, readonly SearchHit[]>>;
  readonly failures: readonly string[];
}

type SearchAnswer =
  | { readonly set: AnalogSet; readonly hits: readonly SearchHit[] }
  | { readonly set: AnalogSet; readonly failure: string };

async function searchAll(deps: AnalogDeps, env: StageEnv, searches: QueriesBySet): Promise<Searched> {
  const asked = ANALOG_SETS.flatMap((set) => searches[set].map((query) => ({ set, query })));
  const answers = await mapLimit(asked, SEARCHES_AT_ONCE, async ({ set, query }): Promise<SearchAnswer> => {
    try {
      const answer = await deps.search(query, RESULTS_PER_QUERY, env.signal);
      return { set, hits: answer.results };
    } catch (error) {
      env.signal?.throwIfAborted();
      return { set, failure: `${query}: ${(error as Error).message}` };
    }
  });
  const hitsOf = (set: AnalogSet) =>
    answers.flatMap((answer) => answer.set === set && "hits" in answer ? answer.hits : []);
  return {
    hits: { sameIndustry: hitsOf("sameIndustry"), differentIndustry: hitsOf("differentIndustry") },
    failures: answers.flatMap((answer) => "failure" in answer ? [answer.failure] : []),
  };
}

async function fetchPage(deps: AnalogDeps, env: StageEnv, candidate: Candidate): Promise<FetchedPage | RejectedCandidate> {
  try {
    const [seo, content] = await Promise.all([deps.probes.seo(candidate.url), deps.probes.content(candidate.url)]);
    return fetchedOrRejected(candidate, seo, content);
  } catch (error) {
    env.signal?.throwIfAborted();
    return { url: candidate.url, reason: `not fetched: ${(error as Error).message}` };
  }
}

/** Every candidate fetched live: the pages both probes read, and the rest with why they cannot be analogs. */
async function fetchAll(
  deps: AnalogDeps,
  env: StageEnv,
  candidates: readonly Candidate[],
): Promise<{ readonly pages: FetchedPage[]; readonly unfetched: RejectedCandidate[] }> {
  const fetched = await mapLimit(candidates, FETCHES_AT_ONCE, (candidate) => fetchPage(deps, env, candidate));
  return {
    pages: fetched.filter((result): result is FetchedPage => "seo" in result),
    unfetched: fetched.filter((result): result is RejectedCandidate => "reason" in result),
  };
}

const NOTHING_CHOSEN: AnalogAnswer = { sameIndustry: [], differentIndustry: [], rejected: [] };

/** The Analogs question over this round's fetched pages, after the analogs earlier rounds already kept. */
function chooseAnalogs(
  env: StageEnv,
  question: LanguageQuestion,
  purpose: PagePurpose,
  kept: AnalogPool["kept"],
  pages: readonly FetchedPage[],
): Promise<AnalogAnswer> {
  const earlier = keptGround(kept);
  const reply = replySchemas(env.z).analogAnswer;
  return askLanguage(
    env,
    question,
    [...purposeGround(purpose), "", ...(earlier === "" ? [] : [earlier, ""]), candidatesGround(pages)].join("\n"),
    (value) => env.z.object({ Analogs: reply }).parse(value).Analogs,
  );
}

/** The FollowUp question once for each short set, its answers reduced to the searches no round has run. */
async function followUpSearches(
  env: StageEnv,
  question: LanguageQuestion,
  target: string,
  pool: AnalogPool,
  short: readonly AnalogSet[],
): Promise<QueriesBySet> {
  const reply = replySchemas(env.z).followUp;
  const proposed = await mapLimit(short, short.length, async (set) => {
    const queries = await askLanguage(
      env,
      question,
      [target, "", followUpGround(set, pool)].join("\n"),
      (value) => env.z.object({ FollowUp: reply }).parse(value).FollowUp.queries,
    );
    return [set, queries] as const;
  });
  return untriedBySet(Object.fromEntries(proposed), pool.tried);
}

async function speedOf(deps: AnalogDeps, env: StageEnv, url: string): Promise<PerformanceMeasurement> {
  try {
    return await deps.probes.performance(url, "mobile");
  } catch (error) {
    env.signal?.throwIfAborted();
    return unmeasured(`the performance probe failed: ${(error as Error).message}`);
  }
}

/** A kept choice with the fetch's readings, its visible text cut to the analog cap, and its speed. */
function analogOf(kept: KeptChoice, performance: PerformanceMeasurement): Analog {
  const { content } = kept.page;
  return {
    ...kept.choice,
    measurements: {
      seo: kept.page.seo,
      content: { ...content, visible_text: content.visible_text.slice(0, ANALOG_TEXT_CAP) },
      performance,
    },
  };
}

/**
 * Real, live pages analogous to one target page: the queries step names the industry and writes searches, the
 * searches run, every new result is fetched live through the page probes, one question picks the analogs from this
 * round's fetched pages only, and a deterministic check rejects any pick that was not fetched or whose title does not
 * match. A set still short of three gets up to FOLLOW_UP_ROUNDS more rounds, each opened by a follow-up question that
 * reads every query tried and page rejected. Each kept analog then gets a speed run.
 */
export async function analogsStage(
  env: StageEnv,
  deps: AnalogDeps,
  scene: { readonly url: string; readonly site?: SiteContext },
  measured: Pick<MeasuredAreas, "seo" | "content">,
  purpose: PagePurpose,
  questions: QuestionFile,
): Promise<AnalogsResult> {
  // A purpose judged not auditable says why in `purpose` itself (`not auditable: <reason>`).
  if (purpose.intentClass === "not auditable") return analogsUnmeasured(scene.url, purpose.purpose);

  const target = [
    ...purposeGround(purpose),
    "",
    measuredGroundTruth({ url: scene.url, site: scene.site, measurements: measured }),
  ].join("\n");
  const schemas = replySchemas(env.z);
  env.progress?.("analogs: writing search queries");
  const queries = await askLanguage(
    env,
    languageNamed(questions, "Queries"),
    target,
    (value) => env.z.object({ Queries: schemas.queries }).parse(value).Queries,
  );

  // Round 1 searches what the queries step wrote; each later round, what the follow-up question wrote for each set
  // still short. A set gets at most FOLLOW_UP_ROUNDS follow-ups, no query runs twice and no page is fetched twice.
  let pool = EMPTY_POOL;
  let searches = untriedBySet(queries, []);
  for (let round = 0;; round += 1) {
    env.progress?.(`analogs: search round ${round + 1}`);
    const searched = await searchAll(deps, env, searches);
    if (round === 0 && searched.failures.length > 0 && ANALOG_SETS.every((set) => searched.hits[set].length === 0)) {
      return analogsUnmeasured(scene.url, `every search failed: ${searched.failures.join("; ")}`);
    }
    const found = candidatesFrom(searched.hits, scene.url, pool.considered);
    const fetched = await fetchAll(deps, env, found.candidates);
    const chosen = fetched.pages.length === 0
      ? NOTHING_CHOSEN
      : await chooseAnalogs(env, languageNamed(questions, "Analogs"), purpose, pool.kept, fetched.pages);
    const validated = validateChoices(chosen, fetched.pages, pool);
    pool = afterRound(pool, {
      searched: searches,
      found: [...found.candidates, ...found.rejected].map((entry) => entry.url),
      kept: validated.kept,
      rejected: [...found.rejected, ...fetched.unfetched, ...validated.rejected],
    });

    const short = shortSets(pool.kept);
    if (short.length === 0 || round === FOLLOW_UP_ROUNDS) break;
    searches = await followUpSearches(env, languageNamed(questions, "FollowUp"), target, pool, short);
    if (ANALOG_SETS.every((set) => searches[set].length === 0)) break;
  }

  const kept = ANALOG_SETS.flatMap((set) => pool.kept[set].map((choice) => ({ set, choice })));
  env.progress?.("analogs: measuring speed of the kept pages");
  const speeds = await mapLimit(kept, SPEED_RUNS_AT_ONCE, ({ choice }) => speedOf(deps, env, choice.page.url));
  const analogs = kept.map(({ set, choice }, index) => ({ set, analog: analogOf(choice, speeds[index]!) }));
  const inSet = (set: AnalogSet) => analogs.filter((entry) => entry.set === set).map((entry) => entry.analog);
  return {
    url: scene.url,
    industry: queries.industry,
    sameIndustry: inSet("sameIndustry"),
    differentIndustry: inSet("differentIndustry"),
    rejected: [...pool.rejected],
    shortfalls: shortSets(pool.kept).map((set) => ({ set, kept: pool.kept[set].length, minimum: ANALOG_SET_MIN })),
  };
}
