import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { type Commit, commitsNamed } from "./commits.js";
import { sessionPrompt, type Reviewed } from "./learn_prompt.js";
import type { AgentStep, Exec } from "./omp_session.js";

/** Characters of the applier's answer kept in the log line. */
export const ANSWER_TAIL_CHARS = 1200;

/** What one apply call made of one review: the applier's answer in English, the commits of it that exist. */
export interface Learning {
  conversation: string;
  review_path: string;
  answer_markdown: string;
  commits: Commit[];
  /** Shas the answer named that no repository holds: a claim, not a commit. */
  unverified_shas: string[];
}

/** The router refuses a request while other sessions' requests are in flight (402 `in_flight_budget_exhausted`); it clears in minutes. */
export const IN_FLIGHT_BUDGET = /in_flight_budget_exhausted|exceed your available credits given your current in-flight/;
export const IN_FLIGHT_WAITS_MS: readonly number[] = [60_000, 120_000, 240_000];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A wait that ends early when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    done();
    reject(signal?.reason ?? new Error("aborted"));
  };
  const timer = setTimeout(() => {
    done();
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** The applier's answer; a request the router refused for in-flight budget is retried after a wait, up to three times. */
export async function applierAnswer(
  step: AgentStep,
  prompt: string,
  options: { waitsMs?: readonly number[]; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; log?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const sleep = options.sleep ?? abortableSleep;
  for (const wait of [...(options.waitsMs ?? IN_FLIGHT_WAITS_MS), undefined]) {
    try {
      return await step(prompt, options.signal);
    } catch (error) {
      if (wait === undefined || !IN_FLIGHT_BUDGET.test(errorText(error))) throw error;
      options.log?.(`the router's in-flight budget is exhausted; waiting ${wait / 1000}s before asking the applier again`);
      await sleep(wait, options.signal);
    }
  }
  throw new Error("unreachable: the last attempt either returned or threw");
}

export interface LearnDeps {
  /** One full omp session: prompt in, the applier's answer out. */
  step: AgentStep;
  /** Runs `git` (and the optional `chezmoi`) for sha verification. */
  exec: Exec;
  home?: string;
  /** Waits between retries on the in-flight-budget error; tests pass `[0, 0, 0]`. */
  waitsMs?: readonly number[];
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * The review text `learn` needs on disk: `report_markdown` when given, else the file at `review_path`. The applier
 * reads the file itself, so a missing or blank file fails the call before any session is paid for.
 */
export async function reviewTextOf(review: Reviewed): Promise<string> {
  const onDisk = await readFile(review.review_path, "utf8").catch(() => "");
  if (onDisk.trim() === "") throw new Error(`learn: no review at ${review.review_path} (missing or blank)`);
  const given = review.report_markdown?.trim() ?? "";
  return given !== "" ? review.report_markdown! : onDisk;
}

/** One apply call: the applier gets the review and the transcript by path and answers in English; its commits are checked. */
export async function learn(review: Reviewed, deps: LearnDeps): Promise<Learning> {
  const log = deps.log ?? (() => {});
  deps.signal?.throwIfAborted();
  await reviewTextOf(review);
  const tag = `learn ${review.conversation}`;
  log(`${tag}: asking the applier to implement ${review.review_path}`);
  const answer_markdown = await applierAnswer(deps.step, await sessionPrompt(review, deps.home ?? homedir()), {
    ...(deps.waitsMs === undefined ? {} : { waitsMs: deps.waitsMs }),
    log: (line) => log(`${tag}: ${line}`),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (answer_markdown.trim() === "") throw new Error(`${tag}: the applier returned an empty answer`);
  const { commits, unverified } = await commitsNamed(answer_markdown, deps.exec, {
    home: deps.home ?? homedir(),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  log(
    `${tag}: the applier answered ${answer_markdown.length} characters; ${commits.length} commit(s) verified`
      + `${unverified.length === 0 ? "" : `, ${unverified.length} sha(s) unverified (${unverified.join(", ")})`}`
      + `; answer ends: ${answer_markdown.slice(-ANSWER_TAIL_CHARS)}`,
  );
  return {
    conversation: review.conversation,
    review_path: review.review_path,
    answer_markdown,
    commits,
    unverified_shas: unverified,
  };
}
