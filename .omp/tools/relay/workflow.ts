import { improveTools, reviewTicketRootCause, rewriteTicketToTemplate, workTicket } from "./model_steps.js";
import { failureComment, messageOf } from "./texts.js";
import { getLinearTicket, postTicketCommentAndReadBack, requireGreenPullRequests, settleTicketOutcome } from "./ticket_steps.js";
import type { Closing, Improvement, RelayPorts, RootCauseVerdict, State, WorkRecord } from "./types.js";
import { TICKET_PATTERN, workspaceFor } from "./workspaces.js";
import { UnusableAnswerError } from "./template.js";

/** What the adversarial review's verdict closes the ticket as, when it is not a real, actionable ticket. */
export function closingOfVerdict(verdict: RootCauseVerdict): Closing {
  if (verdict.verdict === "real") throw new Error("a ticket whose claim is real is worked, not closed");
  return {
    outcome: verdict.verdict,
    summary: verdict.summary,
    concerns: verdict.concerns,
    evidence: [...(verdict.rootCause === "" ? [] : [`Root cause: ${verdict.rootCause}`]), ...verdict.evidence],
    supersededBy: verdict.supersededBy,
    closeLinkedPullRequest: verdict.closeLinkedPullRequest,
  };
}

/** What the worked ticket's record closes the ticket as, with what the tooling pass did beside it. */
export function closingOfWork(work: WorkRecord, tooling: Improvement | { toolingError: string }): Closing {
  if ("toolingError" in tooling) {
    // The pass ran (it may have branched, committed or opened a PR) but its answer was unreadable: what it changed is
    // unknown, so the ticket never says nothing was missing.
    return {
      outcome: work.outcome,
      summary: work.summary,
      concerns: [...work.concerns, `The tooling pass's answer could not be read, so what it changed (if anything) is unknown: ${tooling.toolingError}`],
      evidence: work.evidence,
      supersededBy: work.supersededBy,
      closeLinkedPullRequest: work.closeLinkedPullRequest,
    };
  }
  const line = tooling.improvement === "landed" ? `Tooling landed: ${tooling.summary}` : `No tooling was missing: ${tooling.summary}`;
  return {
    outcome: work.outcome,
    summary: work.summary,
    concerns: work.concerns,
    evidence: [...work.evidence, line, ...tooling.evidence],
    supersededBy: work.supersededBy,
    closeLinkedPullRequest: work.closeLinkedPullRequest,
  };
}

export type RelayRun = {
  ticket: string;
  runId: string;
  /** Where the reviewer writes its verdict file; outside every checkout. */
  verdictDirectory: string;
  /** Told the name of each step as it starts, for progress lines. */
  onStep?: (step: string) => void;
};

/**
 * Works one Linear ticket end to end, in order, none skippable: analyze (read, /tickets rewrite, adversarial review — a
 * verdict other than real settles the ticket and ends the run), work, improve the tooling, the red-CI pass over every pull
 * request touched (one that stays red settles the run blocked), then settle. Answers the run state.
 *
 * A run that throws after the ticket was read leaves one comment on the ticket saying what happened, in the factory's
 * voice, then rethrows its own failure with the comment's outcome appended: a comment that does not land never hides the
 * run's failure.
 */
export async function runRelay(ports: RelayPorts, run: RelayRun): Promise<State> {
  if (!TICKET_PATTERN.test(run.ticket)) throw new Error(`"${run.ticket}" is not a Linear ticket identifier such as ZYS-123 or SAH-123`);
  let ticketRead = false;
  try {
    return await steps(ports, run, () => {
      ticketRead = true;
    });
  } catch (error) {
    if (!ticketRead) throw error;
    let note: string;
    try {
      await postTicketCommentAndReadBack(ports, { workspace: workspaceFor(run.ticket), ticket: run.ticket, body: failureComment(messageOf(error)) });
      note = `the failure was left as a comment on ${run.ticket}`;
    } catch (commentError) {
      note = `its failure comment on ${run.ticket} did not land (${messageOf(commentError)})`;
    }
    throw new Error(`${messageOf(error)} [${note}]`, { cause: error });
  }
}

async function steps(ports: RelayPorts, run: RelayRun, ticketWasRead: () => void): Promise<State> {
  const step = (name: string) => run.onStep?.(name);
  const settle = async (state: State, closing: Closing): Promise<State> => {
    if (state.workspace === undefined) throw new Error(`${state.ticket}: the workspace was not resolved before it was needed`);
    const settlement = await settleTicketOutcome(ports, { workspace: state.workspace, ticket: state.ticket, closing, linkedPulls: state.linkedPulls });
    return { ...state, closing, outcome: closing.outcome, linearStatus: settlement.status, closedPullRequests: settlement.closedPullRequests };
  };

  // 1. analyze_ticket
  step("analyze_ticket");
  const { workspace, issue, comments, linkedPulls } = await getLinearTicket(ports, run.ticket);
  ticketWasRead();
  const rewrite = await rewriteTicketToTemplate(ports, { issue, comments });
  const analysed: State = {
    ticket: run.ticket,
    workspace,
    runId: run.runId,
    issue,
    comments,
    linkedPulls,
    body: rewrite.description,
    rewrite,
    closedPullRequests: [],
  };
  if (!rewrite.decipherable) {
    return settle(analysed, {
      outcome: "undecipherable",
      summary: "The ticket cannot be deciphered as written, so it was not started.",
      concerns: rewrite.questions,
      evidence: [],
      closeLinkedPullRequest: false,
    });
  }
  const verdict = await reviewTicketRootCause(ports, { ticket: run.ticket, body: analysed.body, linkedPulls, verdictDirectory: run.verdictDirectory });
  const reviewed: State = { ...analysed, rootCause: verdict };
  if (verdict.verdict !== "real") return settle(reviewed, closingOfVerdict(verdict));

  // 2. work_ticket
  await run.beforeWork?.();
  step("work_ticket");
  const work = await workTicket(ports, { ticket: run.ticket, body: reviewed.body, rootCause: verdict });
  const worked: State = { ...reviewed, work };

  // 3. improve_tools
  step("improve_tools");
  let tooled: State;
  try {
    tooled = { ...worked, improvement: await improveTools(ports, { ticket: run.ticket, work }) };
  } catch (error) {
    // Only an unreadable answer settles from the work record; a pass that could not run at all still fails the run.
    // No retry: the pass branches, commits and opens PRs, so a second attempt could land the tool twice.
    if (!(error instanceof UnusableAnswerError)) throw error;
    tooled = { ...worked, toolingError: error.message };
  }

  // 4. fix_red_ci
  step("fix_red_ci");
  const touched = [...work.pullRequests, ...(tooled.improvement?.pullRequests ?? [])].map(({ url }) => ({ url }));
  if (touched.length > 0) {
    const green = await requireGreenPullRequests(ports, { pullRequests: touched });
    if (!green.green) return settle(tooled, green.blocked);
  }

  // 5. settle_ticket
  step("settle_ticket");
  const tooling = tooled.improvement ?? { toolingError: tooled.toolingError ?? "no tooling answer was recorded" };
  return settle(tooled, closingOfWork(work, tooling));
}
