import { CHECKPOINT_MAX_AGE_MS, MAX_IMPLEMENTATION_ROUNDS } from "./constants.js";
import type { FactoryPorts } from "./ports.js";
import { messageOf } from "./run_ledger.js";
import {
  type Closing,
  type Finding,
  initialState,
  type RepolessWork,
  type RootCauseVerdict,
  type State,
} from "./schemas.js";
import {
  getLinearTicket,
  holdFactoryLock,
  identifyTicketRepository,
  rewriteTicketToTemplate,
} from "./steps_intake.js";
import {
  landTicketPullRequest,
  postTicketCommentAndReadBack,
  requireGreenPullRequests,
  settleTicketOutcome,
  writeTicketAndReadBack,
} from "./steps_close.js";
import {
  implementTicketInWorktree,
  openTicketWorktree,
  publishTicketPullRequest,
  reviewBranchChangeWithOmp,
  reviewTicketRootCauseWithOmp,
  workTicketWithoutCheckout,
} from "./steps_work.js";
import { failureComment } from "./texts.js";
import { type Workspace, workspaceFor } from "./workspaces.js";

export const SOFTWARE_FACTORY_TICKET_ID = "software_factory_ticket";

/** What a run reports as it goes: the step in flight, for a heartbeat or a log line. */
export type Progress = (message: string) => void;

export type RunOptions = {
  signal?: AbortSignal;
  progress?: Progress;
  /** A fresh run id; tests fix it. */
  runId?: string;
};

export type RunResult = {
  state: State;
  /** The step ids this run skipped because an earlier run had finished them. */
  skipped: string[];
  /** True when the run began from an earlier run's checkpoint. */
  resumed: boolean;
};

/** The state a step returns, and whether the run ends there: a settled ticket, an early outcome or a held lock. */
type StepResult = { state: State; end?: true };

const isBlocking = (finding: Finding) => finding.severity === "blocker";
const describeFinding = (finding: Finding) => `[${finding.severity}] ${finding.location}: ${finding.issue}`;

/** The implementation round is over: it found the ticket needs no PR, or its change was not blocked, or the rounds are spent. */
export const roundsDone = (state: State): boolean =>
  state.implementation?.outcome !== "pr_ready"
  || state.changeReview?.verdict !== "BLOCK"
  || state.rounds >= MAX_IMPLEMENTATION_ROUNDS;

/** The run's ending as the ledger records it. */
function endOf(state: State): { status: "success" | "bailed"; outcome?: string; prUrl?: string; rounds?: number } {
  const status = state.outcome === undefined || state.outcome === "pr_ready" ? "success" : "bailed";
  return {
    status,
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
    ...(state.pullRequest === undefined ? {} : { prUrl: state.pullRequest.url }),
    rounds: state.rounds,
  };
}

/** What the pre-review's verdict closes the ticket as. */
function closingOfRootCause(verdict: RootCauseVerdict): Closing {
  if (verdict.verdict === "real") throw new Error("a ticket whose claim is real is worked, not closed");
  return {
    outcome: verdict.verdict,
    summary: verdict.summary,
    concerns: verdict.concerns,
    evidence: [...(verdict.rootCause === "" ? [] : [`Root cause: ${verdict.rootCause}`]), ...verdict.evidence],
    ...(verdict.supersededBy === undefined ? {} : { supersededBy: verdict.supersededBy }),
    closeLinkedPullRequest: verdict.closeLinkedPullRequest,
  };
}

/** What the implementer's outcome, and the change review that followed it, close the ticket as. */
function closingOfImplementation(state: State): Closing {
  const implementation = state.implementation!;
  if (implementation.outcome !== "pr_ready") {
    return {
      outcome: implementation.outcome,
      summary: implementation.summary,
      concerns: implementation.concerns,
      evidence: implementation.evidence,
      ...(implementation.supersededBy === undefined ? {} : { supersededBy: implementation.supersededBy }),
      closeLinkedPullRequest: implementation.closeLinkedPullRequest,
    };
  }
  const review = state.changeReview;
  return {
    outcome: "pr_ready",
    summary: review === undefined ? implementation.summary : `${implementation.summary}\n\nAdversarial review: ${review.verdict}: ${review.summary}`,
    concerns: [...implementation.concerns, ...(review?.findings.map(describeFinding) ?? [])],
    evidence: implementation.evidence,
    closeLinkedPullRequest: false,
  };
}

/** What the record of working a ticket without a checkout closes the ticket as: the deliverable is its summary. */
function closingOfRepoless(work: RepolessWork): Closing {
  return {
    outcome: work.outcome,
    summary: work.summary,
    concerns: work.concerns,
    evidence: work.evidence,
    ...(work.supersededBy === undefined ? {} : { supersededBy: work.supersededBy }),
    closeLinkedPullRequest: work.closeLinkedPullRequest,
  };
}

type Context = { ports: FactoryPorts; workspace: () => Workspace };

/** Ends the run the way `closing` says (status, comment, linked PRs) and records it on the state. */
async function settle(context: Context, state: State, closing: Closing): Promise<State> {
  const settlement = await settleTicketOutcome(context.ports, {
    workspace: context.workspace(),
    ticket: state.ticket,
    closing,
    linkedPulls: state.linkedPulls,
    ...(state.pullRequest === undefined ? {} : { pullRequest: state.pullRequest }),
  });
  return { ...state, closing, outcome: closing.outcome, linearStatus: settlement.status, closedPullRequests: settlement.closedPullRequests };
}

type Step = { id: string; run: (state: State) => Promise<StepResult> };

/** The steps of one ticket's run, in order, up to the implementation loop. */
function stepsBeforeLoop(context: Context): Step[] {
  const { ports } = context;
  return [
    {
      id: "get_linear_ticket",
      run: async (state) => {
        const { issue, comments, linkedPulls } = await getLinearTicket(ports, state.ticket);
        return { state: { ...state, issue, comments, linkedPulls, body: issue.description } };
      },
    },
    {
      id: "analyze_ticket",
      run: async (state) => {
        const { issue, comments } = state;
        if (issue === undefined) throw new Error(`${state.ticket}: analyze_ticket ran before get_linear_ticket`);
        const answer = await rewriteTicketToTemplate(ports, { issue, comments });
        if (answer.decipherable) return { state: { ...state, body: answer.description } };
        return {
          end: true,
          state: await settle(context, state, {
            outcome: "undecipherable",
            summary: "The ticket cannot be deciphered as written, so it was not started.",
            concerns: answer.questions,
            evidence: [],
            closeLinkedPullRequest: false,
          }),
        };
      },
    },
    {
      id: "identify_ticket_repository",
      run: async (state) => {
        const { issue, comments, linkedPulls } = state;
        if (issue === undefined) throw new Error(`${state.ticket}: identify_ticket_repository ran before get_linear_ticket`);
        const identity = await identifyTicketRepository(ports, { workspace: context.workspace(), issue, comments, linkedPulls });
        if (identity.found) {
          return {
            state: {
              ...state,
              repository: identity.repository,
              ...(identity.linkedPullRequest === undefined ? {} : { linkedPullRequest: identity.linkedPullRequest }),
            },
          };
        }
        return { state: { ...state, noRepositoryWhy: identity.why } };
      },
    },
    {
      id: "open_ticket_worktree",
      run: async (state) => {
        const { issue, repository } = state;
        if (issue === undefined) throw new Error(`${state.ticket}: open_ticket_worktree ran before get_linear_ticket`);
        if (repository === undefined) return { state };
        const opening = await openTicketWorktree(ports, {
          ticket: state.ticket,
          checkout: repository.checkout,
          gitBranchName: issue.gitBranchName,
          ...(state.linkedPullRequest === undefined ? {} : { linkedPullRequest: state.linkedPullRequest }),
        });
        if (opening.opened) return { state: { ...state, worktree: opening.worktree } };
        return {
          end: true,
          state: await settle(context, state, {
            outcome: "blocked",
            summary: `The repository this ticket's work belongs in, ${repository.org}/${repository.name}, could not be opened, so the work was not started.`,
            concerns: [opening.why, "Access to that repository — or the ticket naming where its work really lives — would unblock this run."],
            evidence: [],
            closeLinkedPullRequest: false,
          }),
        };
      },
    },
    {
      id: "review_root_cause",
      run: async (state) => {
        const { worktree, noRepositoryWhy } = state;
        // No repository is not a stop and not a skip: the review runs on the ticket's own material, in a scratch directory,
        // so the repo-less work still starts from an adversarial verdict.
        if (worktree === undefined && noRepositoryWhy === undefined) return { state };
        const verdict = await reviewTicketRootCauseWithOmp(ports, {
          ticket: state.ticket,
          body: state.body,
          ...(worktree === undefined ? {} : { worktree }),
          ...(noRepositoryWhy === undefined ? {} : { noRepositoryWhy }),
          linkedPulls: state.linkedPulls,
        });
        if (verdict.verdict === "real") return { state: { ...state, rootCause: verdict } };
        return { end: true, state: await settle(context, { ...state, rootCause: verdict }, closingOfRootCause(verdict)) };
      },
    },
    {
      id: "mark_in_progress",
      run: async (state) => {
        // Set only after a review judged the work, and never for work without a checkout, which settles the ticket at its end.
        if (state.worktree === undefined) return { state };
        const workspace = context.workspace();
        await writeTicketAndReadBack(ports, { workspace, ticket: state.ticket, status: workspace.statuses.inProgress });
        return { state };
      },
    },
  ];
}

function implementStep(context: Context): Step {
  return {
    id: "implement_ticket",
    run: async (state) => {
      const { worktree } = state;
      if (worktree === undefined) return { state };
      if (state.rootCause?.workInThisCheckout === false) return { state };
      const implementation = await implementTicketInWorktree(context.ports, {
        ticket: state.ticket,
        body: state.body,
        worktree,
        ...(state.linkedPullRequest === undefined ? {} : { linkedPullRequest: state.linkedPullRequest.url }),
        findings: state.findings,
      });
      const { changeReview: _dropped, ...rest } = state;
      return { state: { ...rest, implementation, rounds: state.rounds + 1 } };
    },
  };
}

function reviewChangeStep(context: Context): Step {
  return {
    id: "review_change",
    run: async (state) => {
      const { worktree, implementation } = state;
      if (implementation === undefined) return { state };
      if (worktree === undefined) throw new Error(`${state.ticket}: review_change ran before the worktree was opened`);
      if (implementation.outcome !== "pr_ready") return { state };
      const review = await reviewBranchChangeWithOmp(context.ports, {
        ticket: state.ticket,
        body: state.body,
        round: state.rounds,
        makerSummary: implementation.summary,
        worktree,
      });
      if (review.verdict !== "BLOCK") return { state: { ...state, changeReview: review, findings: [] } };
      if (state.rounds < MAX_IMPLEMENTATION_ROUNDS) return { state: { ...state, changeReview: review, findings: review.findings } };
      return {
        state: {
          ...state,
          changeReview: review,
          findings: review.findings,
          implementation: {
            ...implementation,
            outcome: "needs_info" as const,
            concerns: [...implementation.concerns, ...review.findings.filter(isBlocking).map(describeFinding)],
          },
        },
      };
    },
  };
}

/** The steps that follow the implement-and-review loop. */
function stepsAfterLoop(context: Context): Step[] {
  const { ports } = context;
  return [
    {
      id: "work_ticket_without_checkout",
      run: async (state) => {
        if (state.repolessWork !== undefined || state.implementation !== undefined) return { state };
        if (state.worktree !== undefined && state.rootCause?.workInThisCheckout !== false) return { state };
        const repolessWork = await workTicketWithoutCheckout(ports, {
          ticket: state.ticket,
          body: state.body,
          ...(state.noRepositoryWhy === undefined ? {} : { noRepositoryWhy: state.noRepositoryWhy }),
          ...(state.rootCause === undefined ? {} : { rootCause: state.rootCause }),
        });
        return { state: { ...state, repolessWork } };
      },
    },
    {
      id: "publish_ticket_pull_request",
      run: async (state) => {
        const { issue, repository, worktree, implementation } = state;
        if (implementation === undefined) return { state };
        if (issue === undefined || repository === undefined || worktree === undefined) {
          throw new Error(`${state.ticket}: publish_ticket_pull_request ran before the implementation`);
        }
        const pullRequest = await publishTicketPullRequest(ports, {
          workspace: context.workspace(),
          ticket: state.ticket,
          ticketTitle: issue.title,
          ticketUrl: issue.url,
          org: repository.org,
          repo: repository.name,
          worktree,
          implementation,
          ...(state.changeReview === undefined ? {} : { changeReview: state.changeReview }),
          ...(state.linkedPullRequest === undefined ? {} : { linkedPullRequest: state.linkedPullRequest }),
        });
        return { state: pullRequest === undefined ? state : { ...state, pullRequest } };
      },
    },
    {
      id: "fix_red_ci",
      run: async (state) => {
        const { pullRequest } = state;
        if (pullRequest === undefined) return { state };
        const green = await requireGreenPullRequests(ports, { pullRequests: [{ url: pullRequest.url, draft: pullRequest.draft }] });
        if (green.green) return { state };
        return { end: true, state: await settle(context, state, green.blocked) };
      },
    },
    {
      id: "settle_ticket",
      run: async (state) => {
        if (state.implementation !== undefined) return { state: await settle(context, state, closingOfImplementation(state)) };
        if (state.repolessWork === undefined) throw new Error(`${state.ticket}: settle_ticket ran before any work was done`);
        return { state: await settle(context, state, closingOfRepoless(state.repolessWork)) };
      },
    },
    {
      id: "land_pull_request",
      run: async (state) => {
        const { pullRequest } = state;
        if (state.outcome !== "pr_ready" || pullRequest === undefined || pullRequest.draft) return { state };
        const landing = await landTicketPullRequest(ports, {
          workspace: context.workspace(),
          ticket: state.ticket,
          prUrl: pullRequest.url,
          merge: state.merge,
        });
        return { state: { ...state, landing, prLanded: landing.landed } };
      },
    },
  ];
}

/**
 * Works one ticket end to end. The machine-wide lock is taken first (a held lock answers `busy`, touching nothing), the
 * state after every finished step is written to the ticket's checkpoint file, and a rerun of a ticket whose last run did
 * not finish skips the steps the file lists. However the run ends, the lock is released, the ledger records the ending,
 * and a failure leaves one comment on the ticket. A cancelled run keeps its checkpoint.
 */
export async function runTicket(ports: FactoryPorts, input: { ticket: string; merge: boolean }, options: RunOptions = {}): Promise<RunResult> {
  const { ticket } = input;
  const workspace = workspaceFor(ticket);
  const runId = options.runId ?? crypto.randomUUID();
  const progress = options.progress ?? (() => {});
  const signal = options.signal;
  const context: Context = { ports, workspace: () => workspace };

  const earlier = await ports.checkpoints.load(ticket);
  const resumable = earlier !== undefined && !earlier.finished && ports.now() - earlier.updatedAt <= CHECKPOINT_MAX_AGE_MS;
  if (earlier !== undefined && !resumable) await ports.checkpoints.discard(ticket);

  let state: State = resumable
    ? { ...earlier.state, runId, merge: input.merge }
    : initialState({ ticket, merge: input.merge, runId });
  const done = new Set<string>(resumable ? earlier.steps : []);
  const startedAt = resumable ? earlier.startedAt : ports.now();
  const skipped: string[] = [];

  await ports.ledger.startRun({ runId, workflow: SOFTWARE_FACTORY_TICKET_ID, ticket });
  progress(resumable ? `${ticket}: resuming after ${[...done].at(-1) ?? "the start"}` : `${ticket}: starting`);

  const lock = await holdFactoryLock(ports, { runId, ticket });
  if (!lock.held) {
    state = { ...state, outcome: "busy", ...(lock.holder === undefined ? {} : { busyHeldBy: lock.holder }) };
    await ports.ledger.finishRun(runId, { status: "bailed", outcome: "busy" });
    return { state, skipped, resumed: resumable };
  }

  let failure: unknown;
  let ended = false;
  const save = async (finished: boolean) => {
    await ports.checkpoints.save({ version: 1, ticket, runId, startedAt, updatedAt: ports.now(), steps: [...done], state, finished });
  };

  /** One step: skipped when an earlier run finished it, else timed in the ledger and checkpointed when it succeeds. */
  async function step(entry: Step): Promise<boolean> {
    if (ended) return false;
    signal?.throwIfAborted();
    if (done.has(entry.id)) {
      skipped.push(entry.id);
      await ports.ledger.endStep(runId, entry.id, "skipped", "finished in an earlier run");
      return true;
    }
    progress(`${ticket}: ${entry.id}`);
    await ports.ledger.startStep(runId, entry.id);
    try {
      const result = await entry.run(state);
      state = result.state;
      if (result.end === true) ended = true;
      done.add(entry.id);
      await ports.ledger.endStep(runId, entry.id, "succeeded");
      await save(false);
      return !ended;
    } catch (error) {
      await ports.ledger.endStep(runId, entry.id, "failed", messageOf(error));
      throw error;
    }
  }

  try {
    // A resumed run whose worktree was removed in between opens it again before any step needs it.
    if (resumable && state.worktree !== undefined && state.repository !== undefined && !(await ports.repos.worktreeExists(state.worktree.path))) {
      await ports.ledger.startStep(runId, "reopen_worktree");
      const opening = await openTicketWorktree(ports, {
        ticket,
        checkout: state.repository.checkout,
        gitBranchName: state.issue?.gitBranchName ?? state.worktree.branch,
        ...(state.linkedPullRequest === undefined ? {} : { linkedPullRequest: state.linkedPullRequest }),
      });
      if (!opening.opened) throw new Error(`${ticket}: the worktree of the earlier run is gone and cannot be opened again: ${opening.why}`);
      state = { ...state, worktree: opening.worktree };
      await ports.ledger.endStep(runId, "reopen_worktree", "succeeded");
    }

    for (const entry of stepsBeforeLoop(context)) await step(entry);
    // The implement-and-review loop: one round, then its adversarial review, until the rounds are done.
    for (let round = 1; !ended; round++) {
      const implement = implementStep(context);
      const review = reviewChangeStep(context);
      await step({ ...implement, id: `${implement.id}#${round}` });
      await step({ ...review, id: `${review.id}#${round}` });
      if (ended) break;
      // A later round an earlier run already ran means this round's own outcome was "go on": `state` is that later
      // round's by now, so it is not read for the decision.
      if (done.has(`${implement.id}#${round + 1}`)) continue;
      if (roundsDone(state)) break;
    }
    for (const entry of stepsAfterLoop(context)) await step(entry);
    ended = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await ports.lock.release(runId);
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    const reason = messageOf(failure);
    // One comment in the factory's own voice, so a ticket never waits silent on a run that could not finish. Never thrown:
    // a comment that does not land must not lose the ledger's record of the failure. A cancelled run says nothing.
    if (signal?.aborted !== true) {
      try {
        await postTicketCommentAndReadBack(ports, { workspace, ticket, body: failureComment(reason) });
      } catch (commentError) {
        progress(`${ticket}: the run failed (${reason}) and its failure comment did not land (${messageOf(commentError)})`);
      }
    }
    await ports.ledger.finishRun(runId, { status: "failed", error: reason, rounds: state.rounds });
    throw failure;
  }
  await save(true);
  await ports.ledger.finishRun(runId, endOf(state));
  return { state, skipped, resumed: resumable };
}
