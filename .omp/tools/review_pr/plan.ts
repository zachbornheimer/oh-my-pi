import { createHash } from "node:crypto";
import type { CommentableLines } from "./diff.js";
import type { ReviewerResult, ReviewFinding } from "./types.js";

/** GitHub refuses a review or comment body longer than 65,536 characters. */
const MAX_BODY = 65_000;
const MARK_LINE = /^<!-- review_pr:(finding [0-9a-f]{16}|summary [0-9a-f]{40}) -->$/i;

/**
 * The marks a body carries: only the unbroken run of mark lines at its very end, which is where `clip` writes them.
 * A mark-shaped string anywhere else (inside a quoted code block, in reviewer text) is content, not a mark, so it
 * cannot make a finding look already posted. Returns the `finding <id>` and `summary <sha>` keys.
 */
export function marksOf(body: string): Set<string> {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const marks = new Set<string>();
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const match = MARK_LINE.exec(lines[at]!);
    if (match === null) break;
    marks.add(match[1]!.toLowerCase());
  }
  return marks;
}
const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** One inline thread in a GitHub "create a review" request, anchored to new-side lines of the diff. */
export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "RIGHT";
  readonly body: string;
}

/** The review to post: its summary body, its inline threads, and how the findings were placed. */
export interface ReviewPlan {
  /** False when the PR already carries every finding and a summary for this head: posting would only repeat it. */
  readonly post: boolean;
  readonly body: string;
  readonly comments: readonly InlineComment[];
  readonly inline: number;
  readonly in_summary: number;
  readonly already_posted: number;
}

/** What the PR already carries from earlier runs: every comment and review body on it. */
export interface Posted {
  readonly bodies: readonly string[];
}

/** Where the review is posted and how its findings link to code. */
export interface ReviewTarget {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
}

interface Placed {
  readonly reviewer: string;
  readonly finding: ReviewFinding;
  readonly fingerprint: string;
  readonly anchor?: Anchor;
  readonly posted: boolean;
}

interface Anchor {
  readonly line: number;
  readonly start_line?: number;
}

/**
 * A finding's identity across runs and pushes. A reviewer that reports its own stable id (SARIF fingerprints) wins;
 * otherwise the identity is the reviewer, file, category and the code it flags, or its wording when it quotes none.
 * Not lines, which move with every commit, and not wording alone, which a model changes on every run.
 */
export function fingerprint(reviewer: string, finding: ReviewFinding): string {
  if (finding.fingerprint !== undefined && /^[0-9a-f]{16}$/i.test(finding.fingerprint)) return finding.fingerprint.toLowerCase();
  const subject = (finding.existing_code?.trim() ? finding.existing_code : finding.content).trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${reviewer}\0${finding.path}\0${finding.category ?? ""}\0${subject}`)
    .digest("hex")
    .slice(0, 16);
}

/** The hidden mark `marksOf` reads back: one per posted finding, in its thread or in the summary. */
function findingMark(print: string): string {
  return `<!-- review_pr:finding ${print} -->`;
}

export function summaryMark(headSha: string): string {
  return `<!-- review_pr:summary ${headSha} -->`;
}

export interface PostedThread {
  readonly id: string;
  readonly body: string;
  readonly commitSha: string;
  readonly resolved: boolean;
}

/**
 * Threads to resolve after a new commit. A thread on the current head stays open. A thread whose reviewer failed
 * this run stays open, because that reviewer did not say the finding is gone.
 */
export function threadsToResolve(
  threads: readonly PostedThread[],
  reviewers: readonly ReviewerResult[],
  headSha: string,
): string[] {
  const live = new Set(
    reviewers.flatMap((result) => result.findings.map((finding) => fingerprint(result.reviewer, finding))),
  );
  return threads.flatMap((thread) => {
    if (thread.resolved || thread.commitSha === headSha) return [];
    const marks = [...marksOf(thread.body)].filter((mark) => mark.startsWith("finding ")).map((mark) => mark.slice(8));
    if (marks.length === 0 || marks.some((mark) => live.has(mark))) return [];
    const owner = reviewers.find((result) => thread.body.includes(`_${result.reviewer}_`));
    return owner?.status === "complete" ? [thread.id] : [];
  });
}

/**
 * The new-side lines a finding's thread attaches to. Both ends in one hunk: a range. Otherwise the end line, then the
 * start line, when either is in the diff. Neither: undefined, and the finding goes to the summary.
 */
export function anchorOf(finding: ReviewFinding, lines: CommentableLines): Anchor | undefined {
  const file = lines.get(finding.path);
  const start = finding.start_line ?? finding.end_line;
  const end = finding.end_line ?? finding.start_line;
  if (file === undefined || start === undefined || end === undefined) return undefined;
  const startHunk = file.get(start);
  const endHunk = file.get(end);
  if (start < end && startHunk !== undefined && startHunk === endHunk) return { start_line: start, line: end };
  if (endHunk !== undefined) return { line: end };
  if (startHunk !== undefined) return { line: start };
  return undefined;
}

/** Keeps reviewer text from closing or forging the hidden markers this capability reads back. */
function inert(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function label(finding: ReviewFinding): string {
  const tags = [finding.severity, finding.category].filter((tag): tag is string => Boolean(tag));
  return tags.length === 0 ? "" : `**[${tags.join(" · ")}]** `;
}

function lineRange(finding: ReviewFinding): string {
  const start = finding.start_line ?? finding.end_line;
  const end = finding.end_line ?? finding.start_line;
  if (start === undefined) return "";
  return end !== undefined && end !== start ? `L${start}-L${end}` : `L${start}`;
}

function location(target: ReviewTarget, finding: ReviewFinding): string {
  const range = lineRange(finding);
  const path = finding.path.split("/").map(encodeURIComponent).join("/");
  const url = `https://github.com/${target.owner}/${target.repo}/blob/${target.headSha}/${path}${
    range ? `#${range}` : ""
  }`;
  return `[\`${finding.path}${range ? `:${range.replaceAll("L", "")}` : ""}\`](${url})`;
}

/** The suggested code: a one-click GitHub suggestion when the thread covers exactly the lines it replaces. */
function suggestion(finding: ReviewFinding, anchor: Anchor | undefined): string {
  const code = finding.suggestion_code;
  if (!code) return "";
  const fence = fenceFor(code);
  const start = finding.start_line ?? finding.end_line;
  const exact = anchor !== undefined && (anchor.start_line ?? anchor.line) === start
    && anchor.line === (finding.end_line ?? finding.start_line);
  return exact
    ? `\n\n${fence}suggestion\n${code}\n${fence}`
    : `\n\n<details><summary>Suggested code</summary>\n\n${fence}\n${code}\n${fence}\n\n</details>`;
}

/** A copy-paste prompt, collapsed, so an agent can fix the finding the way Greptile's comments do. */
function fixPrompt(placed: Placed): string {
  const { finding } = placed;
  const line = finding.end_line ?? finding.start_line;
  const text = [
    "This is a comment left during a code review.",
    `Path: ${finding.path}`,
    ...(line === undefined ? [] : [`Line: ${line}`]),
    "",
    "Comment:",
    inert(finding.content.trim()).replaceAll("</details>", "&lt;/details&gt;"),
    ...(finding.suggestion_code ? ["", "Suggested replacement:", finding.suggestion_code] : []),
    "",
    "---",
    "",
    "Determine whether this is valid and should be fixed. If so, fix it directly.",
  ].join("\n");
  const fence = fenceFor(text);
  return `\n\n<details><summary>Prompt To Fix With AI</summary>\n\n${fence}markdown\n${text}\n${fence}\n\n</details>`;
}

function threadText(placed: Placed): string {
  const { finding, reviewer } = placed;
  const reference = finding.reference === undefined ? "" : `\n\n[Rule](${finding.reference})`;
  return `${label(finding)}_${reviewer}_\n\n${inert(finding.content.trim())}${
    suggestion(finding, placed.anchor)
  }${reference}${fixPrompt(placed)}`;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function summaryBody(target: ReviewTarget, reviewers: readonly ReviewerResult[], placed: readonly Placed[]): string {
  const total = placed.length;
  const inline = placed.filter((item) => item.anchor !== undefined && !item.posted).length;
  const outside = placed.filter((item) => item.anchor === undefined);
  const fresh = outside.filter((item) => !item.posted);
  const repeated = placed.filter((item) => item.posted).length;
  const counts = [`${inline} new inline`, `${fresh.length} new outside the diff`, `${repeated} already on this PR`];
  const table = reviewers.map((result) =>
    `| ${result.reviewer} | ${result.status}${
      result.error ? `: ${inert(firstLine(result.error))}` : ""
    } | ${result.findings.length} |`
  );
  const sections = [
    "## Automated code review",
    `Reviewed \`${target.headSha.slice(0, 7)}\` · ${total} finding${total === 1 ? "" : "s"}: ${counts.join(", ")}.`,
    ["| Reviewer | Status | Findings |", "| --- | --- | --- |", ...table].join("\n"),
  ];
  if (outside.length > 0) {
    sections.push(
      "### Findings outside the diff",
      outside.map((item) =>
        `- ${label(item.finding)}${location(target, item.finding)} (_${item.reviewer}_)${
          item.posted ? " (already on this PR)" : ""
        }\n\n  `
        + inert(item.finding.content.trim()).replaceAll("\n", "\n  ")
      ).join("\n\n"),
    );
  }
  if (total > 0) {
    const rows = placed.map((item) =>
      `- ${label(item.finding)}${location(target, item.finding)}: ${inert(firstLine(item.finding.content))}`
      + (item.anchor === undefined ? "" : " (inline)")
    );
    sections.push(`<details><summary>All findings (${total})</summary>\n\n${rows.join("\n")}\n\n</details>`);
  }
  const marks = [summaryMark(target.headSha), ...outside.map((item) => findingMark(item.fingerprint))];
  return clip(sections.join("\n\n"), marks.join("\n"));
}

/** Cuts the visible text, never the hidden marks, so a long review still dedupes on the next run. */
function clip(text: string, marks: string): string {
  const room = MAX_BODY - marks.length - 64;
  const visible = text.length > room ? `${text.slice(0, room)}\n\n… (truncated)` : text;
  return `${visible}\n\n${marks}`;
}

function bySeverity(a: Placed, b: Placed): number {
  const rank = (item: Placed) => SEVERITY_RANK[item.finding.severity?.toLowerCase() ?? ""] ?? 5;
  return rank(a) - rank(b);
}

/**
 * Places every finding: an inline thread when its lines are in the diff, the summary otherwise. A finding an earlier
 * run already posted is counted, not repeated. Throws when every reviewer failed: there is nothing true to attach.
 */
export function planReview(
  target: ReviewTarget,
  reviewers: readonly ReviewerResult[],
  lines: CommentableLines,
  posted: Posted,
): ReviewPlan {
  if (reviewers.length > 0 && reviewers.every((result) => result.status === "failed")) {
    throw new Error(
      `every reviewer failed: ${reviewers.map((r) => `${r.reviewer}: ${r.error ?? "unknown"}`).join("; ")}`,
    );
  }
  const seen = new Set(
    posted.bodies.flatMap((body) => [...marksOf(body)].filter((mark) => mark.startsWith("finding ")).map((mark) => mark.slice(8))),
  );
  const placed: Placed[] = reviewers.flatMap((result) =>
    result.findings.map((finding) => {
      const print = fingerprint(result.reviewer, finding);
      return {
        reviewer: result.reviewer,
        finding,
        fingerprint: print,
        anchor: anchorOf(finding, lines),
        posted: seen.has(print),
      };
    })
  ).sort(bySeverity);
  const comments = placed
    .filter((item) => item.anchor !== undefined && !item.posted)
    .map((item): InlineComment => ({
      path: item.finding.path,
      line: item.anchor!.line,
      side: "RIGHT",
      ...(item.anchor!.start_line === undefined ? {} : { start_line: item.anchor!.start_line, start_side: "RIGHT" }),
      body: clip(threadText(item), findingMark(item.fingerprint)),
    }));
  const in_summary = placed.filter((item) => item.anchor === undefined && !item.posted).length;
  const already_posted = placed.filter((item) => item.posted).length;
  const summarized = posted.bodies.some((body) => marksOf(body).has(`summary ${target.headSha.toLowerCase()}`));
  const nothingNew = comments.length === 0 && in_summary === 0;
  const failed = reviewers.some((result) => result.status === "failed");
  return {
    post: !nothingNew || (!summarized && !failed),
    body: summaryBody(target, reviewers, placed),
    comments,
    inline: comments.length,
    in_summary,
    already_posted,
  };
}
