import { amalgamateFindings, type Finding, fixPrompt, type Suggestion } from "./findings.js";
import type { RepoPort } from "./repo.js";
import type { TicketResolver, TicketSpecifics } from "./ticket.js";

/** What became of a round's change: committed, refused by the repo's commit hooks, or none new to commit. */
export type RoundCommit = "committed" | "refused" | "unchanged";

/** One review round: what became of its change, what each review found, and whether the repo's gate held. */
export interface Round {
  round: number;
  commit: RoundCommit;
  codeFindings: number;
  securityFindings: number;
  blocking: number;
  /** False when the gate failed or the round never reached it. */
  testsOk: boolean;
}

/** What the improve-pr pass on the landed pull request came to. It runs after the PR is open and never un-lands it. */
export type ImprovePrResult =
  | {
      status: "complete";
      ciStatus: string;
      reviewStatus: string;
      unresolvedThreads: number;
      requiresAnotherPass: boolean;
      finalHeadSha: string;
    }
  | { status: "failed"; error: string };

export interface ExecuteTicketOutput {
  /** The atask objective ids the ticket resolved to, its own first. */
  ataskIds: string[];
  linearIdentifier?: string;
  worktree: string;
  rounds: Round[];
  /** Landed: the pull request URL. Otherwise the run stopped without landing. */
  prUrl?: string;
  /** Suggestions and nits both reviews left, for the PR body. */
  suggestions: Suggestion[];
  /** landed: reviews and gate clean, PR open, improve-pr attempted. exhausted: maxRounds closed nothing. */
  status: "landed" | "exhausted";
  /** What stopped an exhausted run: every blocker still standing after the last round. */
  blockers: string[];
  /** Present when landed: the improve-pr pass on the new pull request. */
  improvePr?: ImprovePrResult;
}

/** The reviews and the landing a run drives, besides the ticket and the repo. */
export interface ExecuteTicketPorts {
  readonly resolver: TicketResolver;
  readonly repo: RepoPort;
  /** Implements the ticket in the worktree (a full omp session); resolves when it finished. */
  readonly implementer: (brief: string, worktree: string) => Promise<void>;
  /** The two reviews a round runs. */
  readonly reviews: Readonly<Record<"code" | "security", (diff: string, focus: string) => Promise<readonly Finding[]>>>;
  /** The pull request's own improvement pass, on the landed PR. */
  readonly improvePr: (prUrl: string) => Promise<ImprovePrResult>;
  /** Runs one named phase: the tool reports each as a progress line. */
  readonly step: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/** The implementation prompt one round reads: the ticket brief, then the round's fix list. */
function roundPrompt(body: string, blockers?: readonly string[]): string {
  const fix = blockers === undefined ? "" : `\n\n${fixPrompt(blockers)}`;
  return `${body}${fix}`;
}

/**
 * One round's commit message: a Conventional Commits subject that repo hooks accept, short whatever the ticket's
 * title, with the title in the body. The implementer cannot change this text, so a hook must never refuse it.
 */
export function roundCommitMessage(
  specifics: { readonly title: string; readonly ataskIds: readonly string[]; readonly linearIdentifier?: string },
  round: number,
): string {
  const ticket = specifics.linearIdentifier ?? specifics.ataskIds[0] ?? "ticket";
  return `chore(execute-ticket): implement round ${round} of ${ticket}\n\n${specifics.title}`;
}

/** The pull request body: what the ticket names, and what the reviews left open. */
function pullRequestBody(ataskIds: readonly string[], suggestions: readonly Suggestion[]): string {
  const open =
    suggestions.length === 0
      ? ""
      : `Suggestions left open:\n${suggestions.map((s) => `- [${s.severity}] ${s.path}: ${s.description}`).join("\n")}`;
  return `atask: ${ataskIds.join(", ")}\n\n${open}`;
}

function landed(
  specifics: TicketSpecifics,
  rounds: Round[],
  prUrl: string,
  suggestions: readonly Suggestion[],
  improvePr: ImprovePrResult,
): ExecuteTicketOutput {
  return {
    ataskIds: [...specifics.ataskIds],
    ...(specifics.linearIdentifier === undefined ? {} : { linearIdentifier: specifics.linearIdentifier }),
    worktree: specifics.worktree,
    rounds,
    prUrl,
    suggestions: [...suggestions],
    status: "landed",
    blockers: [],
    improvePr,
  };
}

function exhausted(
  specifics: TicketSpecifics,
  rounds: Round[],
  suggestions: readonly Suggestion[],
  blockers: readonly string[],
): ExecuteTicketOutput {
  return {
    ataskIds: [...specifics.ataskIds],
    ...(specifics.linearIdentifier === undefined ? {} : { linearIdentifier: specifics.linearIdentifier }),
    worktree: specifics.worktree,
    rounds,
    suggestions: [...suggestions],
    status: "exhausted",
    blockers: [...blockers],
  };
}

/**
 * Like Promise.all, but waits for every promise to settle before throwing the first failure, so a failed review never
 * leaves the test gate running unobserved behind the error.
 */
async function allOrFirstFailure<T extends readonly Promise<unknown>[]>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(promises);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as never;
}

/**
 * The whole ticket pass: resolve the ticket (filing its atask representation when it has none), implement it in its
 * own worktree, then rounds of parallel code review, security review and the repo's test gate until a round lands
 * clean, then open the pull request and run improve-pr on it. Bounded by `maxRounds`: a run that closes nothing
 * reports `exhausted` with the blockers still standing, and never lands.
 */
export async function executeTicket(
  input: { readonly ataskId?: string; readonly linearTicket?: string; readonly maxRounds: number },
  ports: ExecuteTicketPorts,
): Promise<ExecuteTicketOutput> {
  const specifics = await ports.step("resolve", () =>
    ports.resolver.resolve({ ataskId: input.ataskId, linearTicket: input.linearTicket }),
  );
  const focus = specifics.title;
  const rounds: Round[] = [];
  let suggestions: readonly Suggestion[] = [];
  let blockers: readonly string[] = [];

  for (let round = 1; round <= input.maxRounds; round++) {
    await ports.step(`implement-${round}`, () =>
      ports.implementer(roundPrompt(specifics.body, round === 1 ? undefined : blockers), specifics.worktree),
    );
    // A rerun finds earlier rounds' work already committed, so an empty round diff alone means nothing.
    const roundDiff = await ports.repo.diff(specifics.worktree);
    let commitOutcome: "committed" | "unchanged" = "unchanged";
    if (roundDiff.trim() !== "") {
      const commit = await ports.repo.commit(specifics.worktree, roundCommitMessage(specifics, round));
      if (!commit.committed) {
        // The repo's own hooks are a gate like its tests: their refusal goes back to the implementer, never bypassed.
        rounds.push({ round, commit: "refused", codeFindings: 0, securityFindings: 0, blocking: 1, testsOk: false });
        blockers = [`The repo's commit hooks refused this round's change:\n${commit.refusal}`];
        continue;
      }
      commitOutcome = "committed";
    }

    // Reviewers judge the whole branch, not this round's fix alone.
    const branchDiff = await ports.repo.branchDiff(specifics.worktree);
    if (branchDiff.trim() === "") {
      return exhausted(specifics, rounds, [], ["the implementer left no change to review"]);
    }
    const [codeFindings, securityFindings, tests] = await ports.step(`review-${round}`, () =>
      allOrFirstFailure([
        ports.reviews.code(branchDiff, focus),
        ports.reviews.security(branchDiff, focus),
        ports.repo.runTests(specifics.worktree),
      ] as const),
    );
    const verdict = amalgamateFindings({ codeFindings, securityFindings, tests });
    rounds.push({
      round,
      commit: commitOutcome,
      codeFindings: codeFindings.length,
      securityFindings: securityFindings.length,
      blocking: verdict.blockers.length,
      testsOk: tests.ok,
    });
    suggestions = verdict.suggestions;

    if (verdict.verdict === "land") {
      const prUrl = await ports.step("land", () =>
        ports.repo.pullRequest(specifics.worktree, focus, pullRequestBody(specifics.ataskIds, suggestions)),
      );
      // The PR is open and stays open: a failed improve-pass is reported beside it, never as a failed landing.
      const improved = await ports.step("improve-pr", () => ports.improvePr(prUrl));
      return landed(specifics, rounds, prUrl, suggestions, improved);
    }
    blockers = verdict.blockers;
  }

  return exhausted(specifics, rounds, suggestions, blockers);
}
