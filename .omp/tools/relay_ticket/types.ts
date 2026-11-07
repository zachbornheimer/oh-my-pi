import type { Landing, LandingRoute } from "./landing.js";
import type { Thread } from "./thread.js";

/** The longest session budget: the sandbox lives budget + provisioning + the driver's margin, under E2B's 1 h continuous cap. */
export const MAX_SESSION_MINUTES = 30;
export const DEFAULT_SESSION_MINUTES = 15;

/** A GitHub repository as `owner/name`: the only repository shape a sandbox session may clone. */
export const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A Linear issue identifier such as ZYS-123. */
export const TICKET_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** What a Linear ticket names: one issue of one workspace, by its identifier. */
export interface LinearTicket {
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  /** The ticket's own sub-issue identifiers, in board order. */
  readonly subIssues: readonly string[];
}

/** Reads one Linear issue with its sub-issues, and posts comments on it. */
export interface LinearPort {
  issue(identifier: string): Promise<LinearTicket>;
  comment(identifier: string, body: string): Promise<void>;
}

/** The input after defaults are applied. */
export interface RelayTicketInput {
  readonly ticket: string;
  readonly repo?: string;
  readonly prompt?: string;
  readonly thread: Thread;
  readonly settleOnTicket: boolean;
  readonly merge: boolean;
  readonly model?: string;
  readonly timeoutMinutes: number;
}

/**
 * What became of the sandbox once the session was over.
 * - already_gone: nothing was up when checked: the driver's own exit path (or a failed provision's own abort) ended it.
 * - released_by_sweep: it was still up, so the tool terminated it.
 * - leaked: it is still up after the sweep. unverified: its presence could not be read. Both may still bill.
 */
export const TEARDOWN_STATES = ["already_gone", "released_by_sweep", "leaked", "unverified"] as const;
export type TeardownState = (typeof TEARDOWN_STATES)[number];

export interface RelayTicketOutput {
  readonly ticket: string;
  /** The sandbox name this run leased. */
  readonly sandbox: string;
  /** The repository the session was told to work in; absent when none was known. */
  readonly repo?: string;
  /** The branch the session was told to work on; absent with `repo`. */
  readonly branch?: string;
  /** succeeded: the session exited 0 and its worktree was dropped. failed: anything else; `reason` says what. */
  readonly status: "succeeded" | "failed";
  readonly reason?: string;
  /** The session driver's exit code; null when the driver never ran or timed out. */
  readonly sessionExit: number | null;
  /** The container-side `E2B-SESSION:` markers the driver printed, by key. */
  readonly markers: Readonly<Record<string, string>>;
  readonly teardown: { readonly state: TeardownState; readonly detail?: string };
  /** Whether the opening progress comment reached the ticket. */
  readonly progressReported: boolean;
  /** Whether the settling comment reached the ticket; false too when `settleOnTicket` was false. */
  readonly settled: boolean;
  /** The settling comment's body, byte for byte. */
  readonly report: string;
  readonly pullRequest?: { readonly url: string; readonly label: string };
  readonly landing?: Landing;
  readonly prLanded?: boolean;
  readonly landingRoute?: LandingRoute;
}
