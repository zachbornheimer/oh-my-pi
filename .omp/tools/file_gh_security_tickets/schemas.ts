import type { GhsecSource, Severity } from "./constants.js";
import type { Workspace } from "./workspaces.js";

/** One open GitHub security alert, tagged and normalised. */
export type AlertItem = {
  /** The ghsec tag that joins this alert to its Linear ticket. */
  tag: string;
  source: GhsecSource;
  number: number;
  severity: Severity;
  /** The alert's html_url. */
  url: string;
  /** The short imperative outcome the ticket title carries after the tag. */
  outcome: string;
  /** The alert's own text for the ticket body's detail section. */
  detail: string;
  state: "open";
  /** The repository as `owner/name`. */
  repo: string;
};

/** One Linear ticket this run indexed under a ghsec tag. */
export type IndexedTicket = { identifier: string; status: string };

/** One indexed ticket whose alert GitHub no longer shows open. */
export type SettleCandidate = { tag: string; identifier: string; status: string };

export type Created = { identifier: string; tag: string };
export type Settled = { identifier: string; tag: string; githubState: string };
export type Failed = { tag: string; reason: string };
export type SkippedRepo = { repo: string; reason: string };

/** What every step of the run reads and returns. */
export type State = {
  target: string;
  dryRun: boolean;
  minSeverity: Severity;
  owner: string;
  workspace: Workspace;
  /** The repositories this run reads, as `owner/name`; a ticket whose tag names another is never touched. */
  visitedRepos: string[];
  skippedRepos: SkippedRepo[];
  /** `owner/name:source` of every source whose alerts could not be listed (403/404): its tickets are never settled. */
  unlisted: string[];
  /** `owner/name:source` of every source whose alerts were listed this run: a 404 on one of its alerts means gone. */
  listed: string[];
  /** Every open security alert of the visited repositories, before `minSeverity` filters what is filed. */
  items: AlertItem[];
  /** The workspace's existing ghsec tickets, by tag. */
  index: Record<string, IndexedTicket>;
  toCreate: AlertItem[];
  toSettle: SettleCandidate[];
  existing: number;
  created: Created[];
  settled: Settled[];
  failed: Failed[];
};

/** The run's typed result. */
export type Result = {
  target: string;
  dryRun: boolean;
  workspace: { team: string };
  repos: { visited: string[]; skipped: SkippedRepo[] };
  /** The alerts at or above `minSeverity`: the set a run files. */
  items: { total: number; bySource: Record<string, number> };
  /** `would*` fields report the diff a dry run stops at; they are empty on a real run. */
  tickets: { created: Created[]; existing: number; settled: Settled[]; failed: Failed[]; wouldCreate: string[]; wouldSettle: string[] };
  minSeverity: Severity;
};
