import { branchFor, conversationFor, repoFor, sandboxNameFor, sessionPrompt } from "./brief.js";
import { type Landing, landingLine } from "./landing.js";
import type { SandboxPort, SessionRun } from "./ports.js";
import { exitMeaning, prepFailure, pullRequestFrom, sessionMarkers, sessionReply, settledComment, startedComment } from "./report.js";
import type { LinearPort, RelayTicketInput, RelayTicketOutput } from "./types.js";

/** What one ticket run needs besides the ticket's own input. */
export interface RelayTicketPorts {
  readonly linear: LinearPort;
  readonly sandbox: SandboxPort;
  /** Lands the pull request the session named (the factory's landing: merged or queued is landed) and answers where it stands; never throws. */
  readonly landPullRequest: (url: string, options: { merge: boolean }) => Promise<Landing>;
  /** A short lowercase token that makes this run's sandbox name and branch its own. */
  readonly suffix: () => string;
  /** Runs one named phase: the runtime reports each as an event; a failing phase is never retried here. */
  readonly step: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly signal?: AbortSignal;
}

type Teardown = RelayTicketOutput["teardown"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The sweeps attempted on a sandbox the driver left behind. */
const SWEEP_ATTEMPTS = 2;

/**
 * Verifies the sandbox is gone and ends it when it is not. The driver's exit path owns the sandbox's lifetime; this is
 * the check on that guarantee, and the sweep for the paths it cannot cover (a failure before the driver armed its
 * teardown, a failed provision, a driver that was killed). The answer is the proof: only `already_gone` and
 * `released_by_sweep` mean nothing is left billing.
 */
export async function verifyTeardown(sandbox: SandboxPort, name: string): Promise<Teardown> {
  try {
    if (!(await sandbox.present(name))) return { state: "already_gone" };
  } catch (error) {
    return { state: "unverified", detail: message(error) };
  }
  let detail = "the sandbox was still up after the session";
  for (let attempt = 1; attempt <= SWEEP_ATTEMPTS; attempt += 1) {
    try {
      await sandbox.down(name);
    } catch (error) {
      detail = `terminate attempt ${attempt} failed: ${message(error)}`;
    }
    try {
      if (!(await sandbox.present(name))) return { state: "released_by_sweep", detail };
    } catch (error) {
      return { state: "unverified", detail: `${detail}; presence unreadable afterwards: ${message(error)}` };
    }
  }
  return { state: "leaked", detail: `${detail}; still up after ${SWEEP_ATTEMPTS} terminate attempts` };
}

/** A progress comment that fails is recorded, never fatal: the work and the teardown matter more than the note. */
async function tryComment(linear: LinearPort, ticket: string, body: string): Promise<boolean> {
  try {
    await linear.comment(ticket, body);
    return true;
  } catch {
    return false;
  }
}

/** The settled verdict of a session driver run: only a clean exit with its worktree dropped is success. */
function verdictOf(run: SessionRun | undefined, markers: Readonly<Record<string, string>>, failure: string | undefined) {
  if (failure !== undefined) return { status: "failed" as const, reason: failure };
  if (run === undefined) return { status: "failed" as const, reason: "the session never ran" };
  if (run.exitCode === 0 && markers.worktree_dropped === "yes") return { status: "succeeded" as const };
  // A container that could not prepare the session says why (a rejected GitHub token, a failed download): that is the reason.
  const prep = prepFailure(run.output);
  return { status: "failed" as const, reason: prep === undefined ? exitMeaning(run) : `the session was not started: ${prep}` };
}

/**
 * One ticket, end to end: read it (before anything is leased), lease a sandbox, say so on the ticket, run the session,
 * verify and if need be sweep the sandbox, settle the outcome on the ticket. Everything after the lease runs inside
 * one guarded region: whatever the lease or the session does, the teardown check runs next, and a sandbox that cannot
 * be shown gone fails the run loudly, after the ticket has been told.
 */
export async function relayTicket(input: RelayTicketInput, ports: RelayTicketPorts): Promise<RelayTicketOutput> {
  const ticket = await ports.step("read_ticket", () => ports.linear.issue(input.ticket));
  const repo = repoFor(input.repo, ticket);
  const suffix = ports.suffix();
  const sandbox = sandboxNameFor(ticket.identifier, suffix);
  const branch = branchFor(ticket.identifier, suffix);

  let run: SessionRun | undefined;
  let failure: string | undefined;
  let progressReported = false;
  try {
    await ports.step("lease_sandbox", () => ports.sandbox.lease({ name: sandbox, minutes: input.timeoutMinutes }, ports.signal));
    // A stop that arrived while the sandbox was provisioning ends the run here: no session is started in a sandbox
    // nobody wants, and the teardown check below sweeps it.
    if (ports.signal?.aborted === true) throw new Error("stopped before the session started");
    progressReported = await tryComment(
      ports.linear,
      ticket.identifier,
      startedComment({ sandbox, ...(repo === undefined ? {} : { repo, branch }), minutes: input.timeoutMinutes, model: input.model }),
    );
    run = await ports.step("run_session", () =>
      ports.sandbox.session(
        {
          name: sandbox,
          branch,
          conversation: conversationFor(ticket.identifier),
          ...(repo === undefined ? {} : { repo }),
          prompt: sessionPrompt(ticket, branch, repo, { prompt: input.prompt, thread: input.thread }),
          model: input.model,
          minutes: input.timeoutMinutes,
        },
        ports.signal,
      ));
  } catch (error) {
    failure = message(error);
  }
  const teardown = await ports.step("verify_teardown", () => verifyTeardown(ports.sandbox, sandbox));

  const markers = run === undefined ? {} : sessionMarkers(run.output);
  const verdict = verdictOf(run, markers, failure);
  const leaked = teardown.state === "leaked" || teardown.state === "unverified";
  const pullRequest = run === undefined ? undefined : pullRequestFrom(sessionReply(run.output), repo);
  // A pull request is landed before the run reports done; nothing is landed from a session that did not end cleanly.
  const landing = pullRequest !== undefined && verdict.status === "succeeded"
    ? await ports.step("land_pull_request", () => ports.landPullRequest(pullRequest.url, { merge: input.merge }))
    : undefined;
  // A landing the caller asked for (merge) that did not land fails the run: the ticket is not done, whatever the session said.
  const unlanded = input.merge && landing !== undefined && !landing.landed ? landing : undefined;
  const outcome: Omit<RelayTicketOutput, "settled" | "report" | "pullRequest" | "landing" | "prLanded"> = {
    ticket: ticket.identifier,
    sandbox,
    ...(repo === undefined ? {} : { repo, branch }),
    status: leaked || unlanded !== undefined ? "failed" : verdict.status,
    reason: leaked
      ? `the sandbox may still be billing (${teardown.state})`
      : unlanded !== undefined
      ? landingLine(unlanded)
      : verdict.reason,
    sessionExit: run?.exitCode ?? null,
    markers,
    teardown,
    progressReported,
  };
  const report = settledComment(outcome, run, landing);
  const settled = input.settleOnTicket
    ? await ports.step("settle_ticket", () => tryComment(ports.linear, ticket.identifier, report))
    : false;
  const result: RelayTicketOutput = {
    ...outcome,
    settled,
    report,
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(landing === undefined ? {} : { landing, prLanded: landing.landed, landingRoute: landing.route }),
  };

  if (leaked) {
    throw new Error(
      `relay_ticket: sandbox ${sandbox} is ${teardown.state}: ${teardown.detail ?? ""} — run: mise -C <dev-env> run container:down --name ${sandbox}`,
    );
  }
  if (input.settleOnTicket && !settled) {
    throw new Error(`relay_ticket: ${ticket.identifier} ended ${result.status} but its settling comment did not post: ${JSON.stringify(result)}`);
  }
  return result;
}
