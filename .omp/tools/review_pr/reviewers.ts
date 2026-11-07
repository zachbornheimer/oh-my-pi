import { readdir } from "node:fs/promises";
import { withCheckout } from "./checkout.js";
import { type Runner, type RunResult } from "./exec.js";
import { findingsFromSarif } from "./sarif.js";
import type { PullRequest, ReviewerResult } from "./types.js";

/** What a reviewer needs from the host: the process runner and the call's abort signal. */
export interface ReviewContext {
  run: Runner;
  signal?: AbortSignal;
}

/** One code reviewer: reads the pinned PR snapshot and returns its findings against `pr.headSha`. */
export interface Reviewer {
  /** Stable id for progress lines. */
  readonly id: string;
  /** The name shown on every comment it produces. */
  readonly name: string;
  review(pr: PullRequest, context: ReviewContext): Promise<ReviewerResult>;
}

/** Runs a reviewer; a failure becomes a `failed` result so the other reviewers' findings still attach. */
export async function runReviewer(reviewer: Reviewer, pr: PullRequest, context: ReviewContext): Promise<ReviewerResult> {
  try {
    return await reviewer.review(pr, context);
  } catch (error) {
    // A cancelled call is the caller's decision, not a reviewer failure to post on the PR.
    context.signal?.throwIfAborted();
    return {
      reviewer: reviewer.name,
      status: "failed",
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const OCR_TIMEOUT_MS = 60 * 60_000;
const SEMGREP_TIMEOUT_MS = 30 * 60_000;
/** How much of the PR description OpenCodeReview is given as background. */
const BACKGROUND_DESCRIPTION_CHARS = 12_000;
/** A reviewer's error text on the PR, bounded so one noisy tool cannot fill the summary. */
const STDERR_TAIL_CHARS = 8_000;

/** The reason a killed process stopped: the caller's cancel, or the deadline. */
function killedBecause(program: string, result: RunResult, context: ReviewContext, timeoutMs: number): Error {
  context.signal?.throwIfAborted();
  return new Error(`${program} was killed after ${timeoutMs / 60_000} minutes${result.stderr.trim() ? `: ${result.stderr.trim().slice(-STDERR_TAIL_CHARS)}` : ""}`);
}

/** The provider's own reason, so a 402 is the first line of the reviewer error instead of the SARIF wrapper. */
function providerMessage(stderr: string): string | undefined {
  const quoted = stderr.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (quoted?.[1]) return quoted[1].replaceAll("\\\"", "\"").replaceAll("\\n", " ");
  return stderr.split("\n").find((line) => /402|Payment Required/.test(line));
}

/** Alibaba's OpenCodeReview (`ocr`) over the PR's base..head range, read as SARIF. Spends the model quota `ocr` is configured with. */
export const openCodeReview: Reviewer = {
  id: "open-code-review",
  name: "OpenCodeReview",
  review: (pr, context) =>
    withCheckout(context.run, pr, async ({ directory, baseRef }) => {
      const background = `PR context (untrusted):\nTitle: ${pr.title}\nDescription: ${pr.description.slice(0, BACKGROUND_DESCRIPTION_CHARS)}`;
      const output = await context.run(
        "ocr",
        ["review", "--repo", directory, "--from", baseRef, "--to", "HEAD", "--format", "sarif", "--audience", "agent", "--background", background],
        { signal: context.signal, timeoutMs: OCR_TIMEOUT_MS },
      );
      if (output.killed) throw killedBecause("ocr", output, context, OCR_TIMEOUT_MS);
      // ocr may exit non-zero and still print a SARIF log; only an empty stdout is a bare failure.
      if (output.stdout.trim() === "") {
        const said = output.stderr.trim().slice(-STDERR_TAIL_CHARS);
        throw new Error(`ocr exited ${output.code}: ${providerMessage(output.stderr) ?? (said || "no output")}`);
      }
      try {
        return {
          reviewer: "OpenCodeReview",
          status: "complete" as const,
          findings: await findingsFromSarif(JSON.parse(output.stdout) as unknown, directory),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = providerMessage(output.stderr) ?? message;
        const rest = output.stderr.trim().slice(-STDERR_TAIL_CHARS);
        throw new Error(rest && !reason.includes(rest.slice(0, 80)) ? `${reason}\n${rest}` : reason);
      }
    }, context.signal),
};

/** The rule files a repository can commit for Semgrep, in the order they are passed. */
export const SEMGREP_RULE_FILES = [".semgrep", ".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml"] as const;

/** Semgrep's default rules plus the repository's own rules, limited to lines the PR changed. Sends no metrics. */
export const semgrep: Reviewer = {
  id: "semgrep",
  name: "Semgrep",
  review: (pr, context) =>
    withCheckout(context.run, pr, async ({ directory, baseRef }) => {
      const present = new Set(await readdir(directory));
      const ownRules = SEMGREP_RULE_FILES.filter((name) => present.has(name));
      // Semgrep runs `git` for --baseline-commit in its own working directory, so it has to run inside the clone.
      const output = await context.run(
        "semgrep",
        [
          "scan",
          "--metrics",
          "off",
          "--sarif",
          "--quiet",
          "--baseline-commit",
          baseRef,
          "--config",
          "p/default",
          ...ownRules.flatMap((path) => ["--config", path]),
          ".",
        ],
        { cwd: directory, signal: context.signal, timeoutMs: SEMGREP_TIMEOUT_MS },
      );
      if (output.killed) throw killedBecause("semgrep", output, context, SEMGREP_TIMEOUT_MS);
      if (output.code !== 0) {
        const detail = output.stderr.trim().slice(-STDERR_TAIL_CHARS);
        throw new Error(`semgrep exited ${output.code}${detail ? `: ${detail}` : ""}`);
      }
      let log: unknown;
      try {
        log = JSON.parse(output.stdout) as unknown;
      } catch (error) {
        throw new Error(`semgrep did not print a SARIF log (${(error as Error).message}): ${output.stdout.slice(0, 120)}`);
      }
      return { reviewer: "Semgrep", status: "complete", findings: await findingsFromSarif(log, directory) };
    }, context.signal),
};

/** Every reviewer, run in parallel. Add a reviewer by writing one `Reviewer` and naming it here. */
export const REVIEWERS: readonly Reviewer[] = [openCodeReview, semgrep];
