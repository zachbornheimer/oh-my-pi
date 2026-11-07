import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { annotatedTranscriptPath } from "./annotate_step.js";
import type { AgentStep, Report } from "./omp_agent.js";
import {
  type DelegatedObjective,
  type FiledObjective,
  type StartTask,
  ataskFilingPort,
  dispatchObjectives,
  fileObjectives,
  filingHeadline,
  objectivesOf,
} from "./objectives.js";
import { PROMPTS_DIRECTORY, type QuestionFile, loadQuestionFile } from "./questions.js";
import type { TurnSource } from "./reader/turn_source.js";
import type { RunAtask } from "./start_task/atask_cli.js";
import { RunTurns, openThread } from "./thread.js";
import { type MachineRecords, worstUnlearnedSource } from "./worst_unlearned.js";

/** The instructions of the two agent definitions the chain's threads run as; placed first in every session prompt. */
export interface Preambles {
  readonly forensics: string;
  readonly pm: string;
}

export async function loadPreambles(directory: string = PROMPTS_DIRECTORY): Promise<Preambles> {
  const [forensics, pm] = await Promise.all([
    readFile(join(directory, "execution-forensics.md"), "utf8"),
    readFile(join(directory, "forensic-pm.md"), "utf8"),
  ]);
  return { forensics, pm };
}

export interface LearnInput {
  /** The session to learn from; absent, the worst unlearned session this machine holds. */
  readonly source?: string;
  readonly dispatch: boolean;
}

/** Everything the chain touches outside itself: each a port, so a test runs the whole chain against fakes. */
export interface LearnDeps {
  /** A full omp session that answers one question (see `omp_agent.ts`). */
  readonly agent: AgentStep;
  /** The atask CLI, for filing. */
  readonly atask: RunAtask;
  /** One worker run per ready filed objective; used only when `dispatch` is true. */
  readonly startTask: StartTask;
  readonly transcripts: TurnSource;
  /** The omp agent dir: the threads' conversation files live under `<agentDir>/threads`. */
  readonly agentDir: string;
  readonly preambles: Preambles;
  readonly loadQuestions?: (name: string) => Promise<QuestionFile>;
  readonly records?: MachineRecords;
  readonly report?: Report;
  /** Answer attempts per question; default 3. */
  readonly attempts?: number;
  readonly signal?: AbortSignal;
}

export interface LearnResult {
  /** The session learned from, as the chain's transcript reader took it. */
  readonly source: string;
  /** True when no source was named and the chain picked the worst unlearned session itself. */
  readonly source_picked: boolean;
  readonly annotated_path: string;
  readonly forensics_thread: string;
  readonly pm_thread: string;
  readonly dispatch: boolean;
  /** One entry per reviewed objective: its atask fields, and with `dispatch` its worker run or the reason none started. */
  readonly objectives: ReadonlyArray<FiledObjective | DelegatedObjective>;
  readonly headline: string;
}

/**
 * The whole learn chain, in fixed order: pick the source, annotate it (no model), run the forensics thread (`analyze` then
 * `root_cause`), run the PM thread (`pm_triage` then `pm_review`), file one atask objective per reviewed objective, and,
 * when `dispatch` is true, start one worker per ready filed objective, serialized per project. Every model answer is
 * validated in code against its question file's schema; a bad shape fails with the reason.
 */
export async function learnFromTranscript(input: LearnInput, deps: LearnDeps): Promise<LearnResult> {
  const report = deps.report ?? (() => undefined);
  const loadQuestions = deps.loadQuestions ?? ((name: string) => loadQuestionFile(name));

  let source = input.source;
  const sourcePicked = source === undefined;
  if (source === undefined) {
    report("picking the worst unlearned session on this machine");
    source = await worstUnlearnedSource(deps.records);
    report(`no source named; learning from the worst unlearned session: ${source}`);
  }

  report(`annotating ${source}`);
  const annotatedPath = await annotatedTranscriptPath(source, deps.transcripts);

  const key = `learn_from_transcript-${digestOf(source)}`;
  const turns = new RunTurns();
  const forensics = openThread({
    path: join(deps.agentDir, "threads", `${key}-t0.jsonl`),
    role: "execution-forensics",
    preamble: deps.preambles.forensics,
    agent: deps.agent,
    loadQuestions,
    turns,
    report,
    attempts: deps.attempts,
    signal: deps.signal,
  });
  await forensics.prompt("analyze", { transcript: annotatedPath });
  await forensics.prompt("root_cause");

  const pm = openThread({
    path: join(deps.agentDir, "threads", `${key}-t1.jsonl`),
    role: "forensic-pm",
    preamble: deps.preambles.pm,
    agent: deps.agent,
    loadQuestions,
    turns,
    report,
    attempts: deps.attempts,
    signal: deps.signal,
  });
  await pm.prompt("pm_triage", { forensics: forensics.path });
  const reviewed = await pm.prompt("pm_review");
  const objectives = objectivesOf(reviewed.Objectives);

  const result = (list: ReadonlyArray<FiledObjective | DelegatedObjective>, headline: string): LearnResult => ({
    source,
    source_picked: sourcePicked,
    annotated_path: annotatedPath,
    forensics_thread: forensics.path,
    pm_thread: pm.path,
    dispatch: input.dispatch,
    objectives: list,
    headline,
  });
  if (objectives.length === 0) return result([], "the PM review found no objective to file");

  report(`filing ${objectives.length} objective(s) with atask`);
  const filed = await fileObjectives(objectives, ataskFilingPort(deps.atask));
  const headline = filingHeadline(filed);
  if (!input.dispatch) return result(filed, headline);

  report(`dispatching workers for ${filed.filter((one) => one.status === "ready").length} ready objective(s)`);
  const delegated = await dispatchObjectives(filed, deps.startTask);
  return result(delegated, headline);
}

/** The stable digest of a source: the same session keeps the same thread files. */
export function digestOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}
