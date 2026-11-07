/** A PR snapshot: every reviewer and the attached review use exactly these commits. */
export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  description: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

/** One finding as a reviewer reported it: the file, the new-side lines, and what is wrong. */
export interface ReviewFinding {
  path: string;
  content: string;
  start_line?: number;
  end_line?: number;
  severity?: string;
  category?: string;
  /** The whole lines a fix replaces, as the checkout holds them. */
  existing_code?: string;
  /** Code that replaces `existing_code`. */
  suggestion_code?: string;
  /** The reviewer's own stable id for the finding: 16 hex characters. */
  fingerprint?: string;
  /** A link to the rule's documentation. */
  reference?: string;
}

/**
 * What one reviewer returned for the pinned head. A reviewer that fails is `failed` with its reason, never a throw:
 * one broken reviewer must not discard the others' findings.
 */
export interface ReviewerResult {
  reviewer: string;
  status: "complete" | "skipped" | "failed";
  findings: ReviewFinding[];
  /** Why the reviewer failed; set only when status is failed. */
  error?: string;
}

export interface AttachedReview {
  /** Whether a review was posted; false when every finding was already on the PR. */
  posted: boolean;
  id?: number;
  html_url?: string;
  /** Findings posted as inline threads on the diff. */
  inline: number;
  /** New findings outside the diff, listed only in the summary. */
  in_summary: number;
  /** Findings skipped because an earlier run posted them. */
  already_posted: number;
  /** Whether an earlier summary on this pull request was replaced. */
  updated: boolean;
  /** Threads resolved because a later commit no longer has the finding. */
  resolved: number;
}

export interface ReviewPrOutput {
  url: string;
  head_sha: string;
  reviewers: ReviewerResult[];
  review: AttachedReview;
}
