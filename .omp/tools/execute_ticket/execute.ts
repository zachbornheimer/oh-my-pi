import { join } from "node:path";
import { ataskCli } from "./atask.js";
import { linearPort } from "./linear.js";
import { type AgentStep, type Exec, type ModelStep, ompAgentStep, ompModelStep } from "./omp.js";
import { codeReview, securityReview } from "./reviews.js";
import { repoPort } from "./repo.js";
import { type ExecuteTicketOutput, type ExecuteTicketPorts, executeTicket, type ImprovePrResult } from "./run.js";
import { ticketResolver } from "./ticket.js";
import { livePorts } from "./improve_pr/live_ports.js";
import { improvePr } from "./improve_pr/workflow.js";

/** The env var that overrides the repo gate a ticket's worktree runs; argv split on whitespace, no shell. */
export const TEST_COMMAND_ENV = "EXECUTE_TICKET_TEST_COMMAND";
export const DEFAULT_TEST_COMMAND = ["mise", "run", "test"];
export const DEFAULT_MAX_ROUNDS = 3;
export const MAX_ROUNDS_LIMIT = 10;

/** An atask id names a branch and a directory, so it is held to one safe word. */
const ATASK_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export interface ExecuteTicketParams {
  ataskId?: string | null;
  linearTicket?: string | null;
  maxRounds?: number | null;
  repoRoot?: string | null;
}

export interface ValidInput {
  ataskId?: string;
  linearTicket?: string;
  maxRounds: number;
  repoRoot?: string;
}

/** Reads and validates the call; throws naming what is wrong. null reads as omitted. */
export function parseInput(params: ExecuteTicketParams): ValidInput {
  const text = (value: string | null | undefined, name: string): string | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`execute_ticket: ${name} must be a string`);
    const trimmed = value.trim();
    if (trimmed === "") throw new Error(`execute_ticket: ${name} must not be blank`);
    return trimmed;
  };
  const ataskId = text(params.ataskId, "ataskId");
  const linearTicket = text(params.linearTicket, "linearTicket");
  const repoRoot = text(params.repoRoot, "repoRoot");
  if (ataskId === undefined && linearTicket === undefined) {
    throw new Error("execute_ticket: name an atask id or a Linear ticket identifier");
  }
  if (ataskId !== undefined && !ATASK_ID.test(ataskId)) {
    throw new Error(`execute_ticket: ataskId ${JSON.stringify(ataskId)} is not an atask id (letters, digits and hyphens, like at-abc123)`);
  }
  const maxRounds = params.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_LIMIT) {
    throw new Error(`execute_ticket: maxRounds must be an integer from 1 to ${MAX_ROUNDS_LIMIT}`);
  }
  return {
    ...(ataskId === undefined ? {} : { ataskId }),
    ...(linearTicket === undefined ? {} : { linearTicket }),
    maxRounds,
    ...(repoRoot === undefined ? {} : { repoRoot }),
  };
}

/** The implementer's one ask: the brief plus the worktree it works in and what is the caller's to do. */
export function implementerPrompt(brief: string, worktree: string): string {
  return [
    `Implement this ticket in the git worktree at ${worktree}.`,
    "Work only inside that directory; never edit any other checkout of the repository.",
    "Leave your changes uncommitted in the working tree: the caller commits each round with the repository's hooks, reviews the whole branch, runs the tests and opens the pull request. Do not push, open a pull request, or call execute_ticket.",
    "",
    brief,
  ].join("\n");
}

export interface Deps {
  readonly exec: Exec;
  /** The directory the call was made from; the default repoRoot. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Called at the start of every phase with its name, and with the improve-pr pass's own progress lines. */
  readonly onPhase?: (name: string) => void;
  /** Substitutes for the live omp sessions in tests. */
  readonly agent?: AgentStep;
  readonly model?: ModelStep;
  readonly improve?: (prUrl: string) => Promise<ImprovePrResult>;
}

/** The improve-pr pass, vendored in ./improve_pr: a failure is reported beside the open PR, a cancellation is not. */
function liveImprove(deps: Deps): (prUrl: string) => Promise<ImprovePrResult> {
  return async (prUrl) => {
    try {
      const outcome = await improvePr(
        livePorts({ signal: deps.signal, progress: (message) => deps.onPhase?.(`improve-pr: ${message}`) }),
        prUrl,
      );
      return {
        status: "complete",
        ciStatus: outcome.ciStatus,
        reviewStatus: outcome.reviewStatus,
        unresolvedThreads: outcome.unresolvedThreads,
        requiresAnotherPass: outcome.requiresAnotherPass,
        finalHeadSha: outcome.finalHeadSha,
      };
    } catch (error) {
      deps.signal?.throwIfAborted();
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** The whole tool: validates the call, wires this machine's ports, runs the ticket pass. */
export async function runExecuteTicket(params: ExecuteTicketParams, deps: Deps): Promise<ExecuteTicketOutput> {
  const input = parseInput(params);
  const env = deps.env ?? process.env;
  const root = input.repoRoot ?? deps.cwd;
  const gate = (env[TEST_COMMAND_ENV]?.trim() || DEFAULT_TEST_COMMAND.join(" ")).split(/\s+/);
  const repo = repoPort({ exec: deps.exec, root, worktreesDir: join(root, "..", ".worktrees"), testCommand: gate, signal: deps.signal });
  const atask = ataskCli({ exec: deps.exec, cwd: root, signal: deps.signal });
  const model = deps.model ?? ompModelStep(deps.exec);
  const agent = deps.agent ?? ompAgentStep(deps.exec);
  const code = codeReview(model);
  const security = securityReview(model);

  const ports: ExecuteTicketPorts = {
    resolver: ticketResolver({
      linear: linearPort({ env, fetch: deps.fetch, signal: deps.signal }),
      atask,
      ataskProject: undefined,
      worktreeFor: async (identifier) => repo.worktree({ identifier }),
      show: (id) => atask.show(id),
    }),
    repo,
    implementer: (brief, worktree) => agent({ cwd: worktree, prompt: implementerPrompt(brief, worktree) }, deps.signal),
    reviews: {
      code: (diff, focus) => code(diff, focus, deps.signal),
      security: (diff, focus) => security(diff, focus, deps.signal),
    },
    improvePr: deps.improve ?? liveImprove(deps),
    step: async (name, fn) => {
      deps.signal?.throwIfAborted();
      deps.onPhase?.(name);
      return fn();
    },
  };
  return executeTicket(
    { ataskId: input.ataskId, linearTicket: input.linearTicket, maxRounds: input.maxRounds },
    ports,
  );
}
