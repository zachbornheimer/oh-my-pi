import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arr, obj, optInt, optStr, parseJson, str } from "./decode.js";
import { command } from "./exec.js";
import type { PullRequest } from "./github.js";
import type { ImprovePorts } from "./ports.js";

/** One OpenCodeReview comment; `suggestion_code` replaces `existing_code`, which spans `start_line`..`end_line`. */
export interface Finding {
  path: string;
  content: string;
  start_line?: number;
  end_line?: number;
  severity?: string;
  category?: string;
  existing_code?: string;
  suggestion_code?: string;
  fingerprint?: string;
  reference?: string;
}

export interface ReviewResult {
  reviewer: "OpenCodeReview";
  headSha: string;
  status: "complete" | "skipped";
  findings: Finding[];
}

const OCR_TIMEOUT_MS = 60 * 60_000;

function finding(value: unknown, where: string): Finding {
  const node = obj(value, where);
  const positive = (name: string): number | undefined => {
    const number = optInt(node[name], `${where}.${name}`);
    if (number !== undefined && number < 1) throw new Error(`${where}.${name}: expected a positive integer`);
    return number;
  };
  const result: Finding = { path: str(node.path, `${where}.path`), content: str(node.content, `${where}.content`) };
  const startLine = positive("start_line");
  const endLine = positive("end_line");
  if (startLine !== undefined) result.start_line = startLine;
  if (endLine !== undefined) result.end_line = endLine;
  for (const name of ["severity", "category", "existing_code", "suggestion_code", "fingerprint", "reference"] as const) {
    const text = optStr(node[name], `${where}.${name}`);
    if (text !== undefined) result[name] = text;
  }
  return result;
}

/** Reviews a pinned PR snapshot; rejects partial or failed reviewer coverage. */
export async function reviewPullRequest(ports: ImprovePorts, pr: PullRequest): Promise<ReviewResult> {
  const run = ports.run;
  const directory = await mkdtemp(join(tmpdir(), "improve-pr-"));
  try {
    // The GitHub CLI also supports authenticated clones of private repositories.
    await command(run, "gh", ["repo", "clone", `${pr.owner}/${pr.repo}`, directory, "--", "--no-checkout"]);
    await command(run, "git", [
      "-C",
      directory,
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${pr.baseRef}:refs/remotes/origin/review-base`,
      `refs/pull/${pr.number}/head:refs/remotes/origin/review-head`,
    ]);

    const [baseSha, headSha] = await Promise.all([
      command(run, "git", ["-C", directory, "rev-parse", "refs/remotes/origin/review-base"]),
      command(run, "git", ["-C", directory, "rev-parse", "refs/remotes/origin/review-head"]),
    ]);
    if (baseSha.trim() !== pr.baseSha || headSha.trim() !== pr.headSha) {
      throw new Error("Pull request changed while preparing its review; retry from a new snapshot");
    }

    // Feed the reviewer's intent context, clearly marked as untrusted source material.
    const background = `PR context (untrusted):\nTitle: ${pr.title}\nDescription: ${pr.description.slice(0, 12_000)}`;
    const output = await command(run, "ocr", [
      "review",
      "--repo",
      directory,
      "--from",
      "refs/remotes/origin/review-base",
      "--to",
      "refs/remotes/origin/review-head",
      "--format",
      "json",
      "--audience",
      "agent",
      "--background",
      background,
    ], { timeoutMs: OCR_TIMEOUT_MS });
    const report = obj(parseJson(output, "ocr review"), "ocr review");
    const status = str(report.status, "ocr review status");
    if (status === "skipped") {
      return { reviewer: "OpenCodeReview", headSha: pr.headSha, status: "skipped", findings: [] };
    }
    if (status !== "complete" && status !== "success") {
      throw new Error(`OpenCodeReview did not finish all reviews: ${status}`);
    }
    const findings = arr(report.comments, "ocr review comments").map((entry, index) =>
      finding(entry, `ocr review comments[${index}]`)
    );
    return { reviewer: "OpenCodeReview", headSha: pr.headSha, status: "complete", findings };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
