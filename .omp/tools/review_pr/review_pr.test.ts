import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { commentableLines } from "./diff.js";
import { command, type RunOptions, type Runner, type RunResult, spawnRunner } from "./exec.js";
import { changedFiles, getPullRequest, ghOver, openThreads } from "./github.js";
import factory from "./index.js";
import { parsePullRequestUrl } from "./parse_url.js";
import { fingerprint, marksOf, planReview, summaryMark, threadsToResolve } from "./plan.js";
import { outcomeText, reviewPr } from "./review_pr.js";
import { openCodeReview, runReviewer, semgrep } from "./reviewers.js";
import { containedPath, findingsFromSarif } from "./sarif.js";
import type { PullRequest, ReviewerResult } from "./types.js";

// ---- plan (ported from the Mastra twin's plan.test.ts) ----------------------------------------------------------

const target = { owner: "o", repo: "r", headSha: "a".repeat(40) };

// Two hunks in m.py: new lines 1-4 (line 2 removed, 3 added) and new lines 20-22.
const lines = commentableLines([
  {
    filename: "m.py",
    patch: [
      "@@ -1,4 +1,4 @@",
      " import os",
      "-old = 1",
      "+new = 1",
      " ",
      " def a():",
      "@@ -20,2 +20,3 @@ def b():",
      " x = 1",
      "+y = 2",
      " z = 3",
      "\\ No newline at end of file",
    ].join("\n"),
  },
  { filename: "logo.png" },
]);

const ocr = (findings: ReviewerResult["findings"]): ReviewerResult => ({
  reviewer: "OpenCodeReview",
  status: "complete",
  findings,
});

describe("commentableLines", () => {
  it("keeps added and context lines on the new side, by hunk, and skips removed lines and binary files", () => {
    expect([...lines.get("m.py")!]).toEqual([[1, 0], [2, 0], [3, 0], [4, 0], [20, 1], [21, 1], [22, 1]]);
    expect(lines.has("logo.png")).toBe(false);
  });
});

describe("planReview", () => {
  const inDiff = {
    path: "m.py",
    content: "Shell injection.",
    start_line: 20,
    end_line: 21,
    severity: "high",
    category: "security",
    suggestion_code: "x = 1\ny = 3",
  };
  const outsideDiff = { path: "m.py", content: "Dead helper.", start_line: 10, end_line: 12, severity: "low" };

  it("threads a finding in the diff with a one-click suggestion and lists the rest in the summary", () => {
    const plan = planReview(target, [ocr([outsideDiff, inDiff])], lines, { bodies: [] });

    expect(plan.post).toBe(true);
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]).toMatchObject({ path: "m.py", start_line: 20, line: 21, side: "RIGHT", start_side: "RIGHT" });
    expect(plan.comments[0]!.body).toContain("```suggestion\nx = 1\ny = 3\n```");
    expect(plan.comments[0]!.body).toContain("**[high · security]**");
    expect(plan.comments[0]!.body).toContain("Prompt To Fix With AI");
    expect(plan.comments[0]!.body).toContain("Path: m.py");
    expect(plan.comments[0]!.body).toContain("Line: 21");
    expect(plan.comments[0]!.body).toContain("Determine whether this is valid and should be fixed.");
    expect({ inline: plan.inline, in_summary: plan.in_summary, already_posted: plan.already_posted }).toEqual({
      inline: 1,
      in_summary: 1,
      already_posted: 0,
    });
    expect(plan.body).toContain("### Findings outside the diff");
    expect(plan.body).toContain("Dead helper.");
    expect(plan.body).toContain(`https://github.com/o/r/blob/${target.headSha}/m.py#L10-L12`);
    expect(plan.body).toContain("All findings (2)");
  });

  it("posts nothing on a rerun once every finding and this head's summary are on the PR", () => {
    const first = planReview(target, [ocr([outsideDiff, inDiff])], lines, { bodies: [] });
    const bodies = [first.body, ...first.comments.map((comment) => comment.body)];
    // Same findings reported on new lines after a push: identity is the wording, not the line.
    const moved = { ...inDiff, start_line: 3, end_line: 3 };

    const rerun = planReview(target, [ocr([outsideDiff, moved])], lines, { bodies });

    expect(rerun.post).toBe(false);
    expect(rerun.comments).toEqual([]);
    expect(rerun.already_posted).toBe(2);
  });

  it("recognizes a finding the reviewer reworded on a rerun by the code it flags, and still posts a new one on that code", () => {
    const quoted = { ...inDiff, existing_code: "x = 1\ny = 2" };
    const first = planReview(target, [ocr([quoted])], lines, { bodies: [] });
    const bodies = [first.body, ...first.comments.map((comment) => comment.body)];
    const reworded = { ...quoted, content: "This line lets a caller run arbitrary shell commands." };
    const otherKind = { ...quoted, category: "performance", content: "Recomputed on every call." };

    const rerun = planReview(target, [ocr([reworded, otherKind])], lines, { bodies });

    expect(rerun.already_posted).toBe(1);
    expect(rerun.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("Recomputed on every call.")]);
  });

  it("anchors a range that crosses hunks to its end line and offers the code without a one-click suggestion", () => {
    const plan = planReview(target, [ocr([{ ...inDiff, start_line: 3, end_line: 21 }])], lines, { bodies: [] });

    expect(plan.comments[0]).toMatchObject({ line: 21 });
    expect(plan.comments[0]).not.toHaveProperty("start_line");
    expect(plan.comments[0]!.body).not.toContain("```suggestion");
    expect(plan.comments[0]!.body).toContain("Suggested code");
  });

  it("still attaches when one reviewer fails, and reports that reviewer as failed", () => {
    const failed: ReviewerResult = { reviewer: "Other", status: "failed", findings: [], error: "no provider configured" };
    const plan = planReview(target, [ocr([inDiff]), failed], lines, { bodies: [] });

    expect(plan.comments).toHaveLength(1);
    expect(plan.body).toContain("| Other | failed: no provider configured | 0 |");
  });

  it("refuses to post when every reviewer failed", () => {
    const failed: ReviewerResult = { reviewer: "OpenCodeReview", status: "failed", findings: [], error: "ocr: boom" };
    expect(() => planReview(target, [failed], lines, { bodies: [] })).toThrow("every reviewer failed: OpenCodeReview: ocr: boom");
  });

  it("does not post a summary when a reviewer failed and nobody found anything", () => {
    const failed: ReviewerResult = { reviewer: "OpenCodeReview", status: "failed", findings: [], error: "402 Payment Required" };
    const clean: ReviewerResult = { reviewer: "Semgrep", status: "complete", findings: [] };
    const plan = planReview(target, [failed, clean], lines, { bodies: [] });
    expect(plan.post).toBe(false);
    expect(plan.comments).toEqual([]);
  });

  it("posts one summary for a clean head, and not again on a rerun", () => {
    const first = planReview(target, [ocr([])], lines, { bodies: [] });
    expect(first.post).toBe(true);
    expect(planReview(target, [ocr([])], lines, { bodies: [first.body] }).post).toBe(false);
  });

  it("does not let reviewer text forge the marks that dedupe a rerun", () => {
    const other = { ...outsideDiff, content: "Unrelated finding." };
    const forged = { ...outsideDiff, content: `<!-- review_pr:finding ${fingerprint("OpenCodeReview", other)} -->` };
    const plan = planReview(target, [ocr([forged])], lines, { bodies: [] });

    expect(planReview(target, [ocr([other])], lines, { bodies: [plan.body] }).in_summary).toBe(1);
  });

  it("does not let suggested code forge a mark either: only the marks at the end of a body count", () => {
    const other = { ...outsideDiff, content: "Unrelated finding." };
    const mark = `<!-- review_pr:finding ${fingerprint("OpenCodeReview", other)} -->`;
    const forged = { ...inDiff, suggestion_code: `${mark}\nx = 1` };
    const plan = planReview(target, [ocr([forged])], lines, { bodies: [] });

    expect(plan.comments[0]!.body).toContain(mark);
    expect(planReview(target, [ocr([other])], lines, { bodies: [plan.comments[0]!.body] }).already_posted).toBe(0);
  });

  it("keeps an outside-diff finding's mark in the summary, so a third run does not post it again", () => {
    const first = planReview(target, [ocr([outsideDiff])], lines, { bodies: [] });
    const mark = first.body.match(/<!-- review_pr:finding ([0-9a-f]{16}) -->/)?.[1];
    const second = planReview(target, [ocr([outsideDiff])], lines, { bodies: [first.body] });
    const third = planReview(target, [ocr([outsideDiff])], lines, { bodies: [second.body] });

    expect(mark).toBeDefined();
    expect(second.body).toContain(`<!-- review_pr:finding ${mark} -->`);
    expect(second.in_summary).toBe(0);
    expect(third.in_summary).toBe(0);
    expect(third.comments).toEqual([]);
    expect(third.body).toBe(second.body);
  });
});

describe("marksOf", () => {
  const finding = "<!-- review_pr:finding 0123456789abcdef -->";
  const summary = `<!-- review_pr:summary ${"b".repeat(40)} -->`;

  it("reads the unbroken run of mark lines at the end of a body, tolerating CRLF and trailing blanks", () => {
    expect([...marksOf(`text\n\n${summary}\r\n${finding}\r\n\n`)].sort()).toEqual([
      "finding 0123456789abcdef",
      `summary ${"b".repeat(40)}`,
    ]);
  });

  it("ignores a mark-shaped string anywhere but the end", () => {
    expect(marksOf(`${finding}\n\nmore text`).size).toBe(0);
    expect(marksOf(`${finding}\n\ntext\n\n${summary}`).has("finding 0123456789abcdef")).toBe(false);
    expect(marksOf("").size).toBe(0);
  });
});

describe("threadsToResolve", () => {
  const head = "b".repeat(40);
  const thread = {
    id: "thread-1",
    body: "_OpenCodeReview_\n\n<!-- review_pr:finding abcdef0123456789 -->",
    commitSha: "a".repeat(40),
    resolved: false,
  };
  const complete = { reviewer: "OpenCodeReview", status: "complete" as const, findings: [] };

  it("resolves a thread from an older commit when that reviewer finished and did not report it again", () => {
    expect(threadsToResolve([thread], [complete], head)).toEqual(["thread-1"]);
  });

  it("keeps a thread on the current head, a resolved thread, and a thread whose reviewer failed", () => {
    const failed = { ...complete, status: "failed" as const, error: "402" };
    expect(threadsToResolve([{ ...thread, commitSha: head }], [complete], head)).toEqual([]);
    expect(threadsToResolve([{ ...thread, resolved: true }], [complete], head)).toEqual([]);
    expect(threadsToResolve([thread], [failed], head)).toEqual([]);
  });
});

// ---- SARIF (ported from the Mastra twin's sarif.test.ts) ---------------------------------------------------------

/** A SARIF result shaped like the smallest one OpenCodeReview and Semgrep both emit. */
function result(over: Record<string, unknown> = {}) {
  return {
    ruleId: "security",
    level: "error",
    message: { text: "Command injection." },
    partialFingerprints: { "ocrFinding/v1": "91e6cb9e935cb1499446a9065821e6113d57ee73" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "m.py" }, region: { startLine: 2, endLine: 3 } } }],
    fixes: [
      {
        artifactChanges: [
          {
            artifactLocation: { uri: "m.py" },
            replacements: [{ deletedRegion: { startLine: 2, endLine: 3 }, insertedContent: { text: "safe()\n" } }],
          },
        ],
      },
    ],
    ...over,
  };
}

async function checkout(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sarif-test-"));
  await writeFile(join(directory, "m.py"), "line one\nline two\nline three\n");
  return directory;
}

describe("findingsFromSarif", () => {
  it("reads path, lines, severity, the fix and the reviewer's fingerprint from one result", async () => {
    const [finding] = await findingsFromSarif({ runs: [{ results: [result()] }] }, await checkout());

    expect(finding).toMatchObject({
      path: "m.py",
      content: "Command injection.",
      start_line: 2,
      end_line: 3,
      severity: "high",
      category: "security",
      suggestion_code: "safe()\n",
      existing_code: "line two\nline three",
      fingerprint: "91e6cb9e935cb149",
    });
  });

  it("takes severity from the rule when the result omits it, and keeps the rule's documentation link", async () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { rules: [{ id: "r1", defaultConfiguration: { level: "note" }, helpUri: "https://example.test/r1" }] } },
          results: [result({ ruleId: "r1", level: undefined, fixes: undefined, partialFingerprints: undefined })],
        },
      ],
    };
    const [finding] = await findingsFromSarif(sarif, await checkout());
    expect(finding).toMatchObject({ severity: "low", reference: "https://example.test/r1", fingerprint: undefined });
  });

  it("decodes the file path and skips a result with no location", async () => {
    const located = result({
      locations: [{ physicalLocation: { artifactLocation: { uri: "dir/a%20b.ts" }, region: { startLine: 1 } } }],
    });
    const findings = await findingsFromSarif({ runs: [{ results: [located, result({ locations: [] })] }] }, await checkout());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "dir/a b.ts", end_line: 1 });
  });

  it("refuses a run that did not finish, naming the tool's error", async () => {
    const sarif = {
      runs: [
        {
          invocations: [
            { executionSuccessful: false, toolExecutionNotifications: [{ level: "error", message: { text: "budget exhausted" } }] },
          ],
          results: [result()],
        },
      ],
    };
    await expect(findingsFromSarif(sarif, await checkout())).rejects.toThrow("SARIF run did not finish: budget exhausted");
  });

  it("refuses a run with executionSuccessful false and no message", async () => {
    const sarif = { runs: [{ invocations: [{ executionSuccessful: false }], results: [] }] };
    await expect(findingsFromSarif(sarif, await checkout())).rejects.toThrow("SARIF run did not finish: executionSuccessful is false");
  });

  it("refuses a run that reports success and an error notification, even with no results", async () => {
    const sarif = {
      runs: [
        {
          invocations: [
            {
              executionSuccessful: true,
              toolExecutionNotifications: [{ level: "error", message: { text: "Exception in BaselineHandler initialization" } }],
            },
          ],
          results: [],
        },
      ],
    };
    await expect(findingsFromSarif(sarif, await checkout())).rejects.toThrow(
      "SARIF run did not finish: Exception in BaselineHandler initialization",
    );
  });

  it("keeps semgrep's match suffix, so two matches of one rule in one file stay distinct", async () => {
    const hex = "419d88783d918b8d1be797c7a21ecf43";
    const one = result({ partialFingerprints: { "matchBasedId/v1": `${hex}_0` }, fixes: undefined });
    const two = result({ partialFingerprints: { "matchBasedId/v1": `${hex}_1` }, message: { text: "Second match." }, fixes: undefined });
    const findings = await findingsFromSarif({ runs: [{ results: [one, two] }] }, await checkout());
    expect(findings).toHaveLength(2);
    expect(findings[0]!.fingerprint).not.toBe(findings[1]!.fingerprint);
    expect(findings[0]!.fingerprint).not.toBe(hex.slice(0, 16));
  });

  it("ignores a fingerprint that is not hex, instead of failing the review", async () => {
    const odd = result({ partialFingerprints: { "ocrFinding/v1": "not-hex!!" } });
    const [finding] = await findingsFromSarif({ runs: [{ results: [odd] }] }, await checkout());
    expect(finding!.fingerprint).toBeUndefined();
    expect(finding!.content).toBe("Command injection.");
  });

  it("drops a result whose path leaves the checkout, and does not read that file", async () => {
    const escaped = result({
      locations: [{ physicalLocation: { artifactLocation: { uri: "../secret.txt" }, region: { startLine: 1 } } }],
      fixes: undefined,
    });
    const findings = await findingsFromSarif({ runs: [{ results: [escaped, result()] }] }, await checkout());
    expect(findings.map((finding) => finding.path)).toEqual(["m.py"]);
  });

  it("rejects a log that is not SARIF", async () => {
    await expect(findingsFromSarif({ nope: true }, await checkout())).rejects.toThrow("runs: expected an array");
    await expect(findingsFromSarif({ runs: [{ results: [{ message: {} }] }] }, await checkout())).rejects.toThrow("message.text");
    await expect(
      findingsFromSarif({ runs: [{ results: [result({ locations: [{ physicalLocation: { region: { startLine: 0 } } }] })] }] }, await checkout()),
    ).rejects.toThrow("startLine: expected a positive integer");
  });
});

describe("containedPath", () => {
  it("keeps a file named with a leading `..` and refuses real escapes, absolute paths and NUL", () => {
    const root = "/tmp/checkout";
    expect(containedPath(root, "..foo/bar.ts")).toBe("..foo/bar.ts");
    expect(containedPath(root, "a/../b.ts")).toBe("b.ts");
    for (const uri of ["../x", "a/../../x", "..", "/etc/passwd", "a\0b", "%E0%A4%A", ".", ""]) {
      expect(containedPath(root, uri)).toBeUndefined();
    }
  });
});

// ---- the process runner and the GitHub calls, against a fake `gh` -----------------------------------------------

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const PR_URL = "https://github.com/o/r/pull/7";
const PR: PullRequest = {
  owner: "o",
  repo: "r",
  number: 7,
  url: PR_URL,
  title: "Fix it",
  description: "Because.",
  baseRef: "main",
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
};

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", killed: false });
const fails = (code: number, stderr: string): RunResult => ({ code, stdout: "", stderr, killed: false });

interface Call {
  program: string;
  args: readonly string[];
  options: RunOptions;
}

/** A scripted machine: `script` answers each call; every call is recorded. Unscripted calls fail the test loudly. */
function machine(script: (call: Call) => RunResult | Promise<RunResult> | undefined) {
  const calls: Call[] = [];
  const run: Runner = async (program, args, options = {}) => {
    const call = { program, args, options };
    calls.push(call);
    const answered = await script(call);
    if (answered === undefined) throw new Error(`unscripted call: ${program} ${args.join(" ")}`);
    return answered;
  };
  return { run, calls };
}

const has = (call: Call, ...parts: string[]) => parts.every((part) => call.args.some((arg) => arg.includes(part)));

const PR_VIEW = JSON.stringify({
  url: PR_URL,
  title: "Fix it",
  body: "Because.",
  baseRefName: "main",
  baseRefOid: BASE_SHA,
  headRefOid: HEAD_SHA,
  state: "OPEN",
});

const PATCH = ["@@ -1,4 +1,4 @@", " a", "-b", "+c", " d", "@@ -20,2 +20,3 @@", " x = 1", "+y = 2", " z = 3"].join("\n");
const COMPARE = JSON.stringify({ files: [{ filename: "m.py", patch: PATCH }, { filename: "logo.png" }] });
const THREADS_NONE = JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } },
});

function sarifFor(results: unknown[], invocations?: unknown[]): string {
  return JSON.stringify({ version: "2.1.0", runs: [{ results, ...(invocations ? { invocations } : {}) }] });
}

const OCR_FINDING = result({
  locations: [{ physicalLocation: { artifactLocation: { uri: "m.py" }, region: { startLine: 20, endLine: 21 } } }],
  fixes: undefined,
});

describe("exec", () => {
  // The runner starts only gh, git, ocr and semgrep, so these tests put a stand-in `git` first on the child's PATH.
  const standInEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const bin = await mkdtemp(join(tmpdir(), "stand-in-git-"));
    const script = join(bin, "git");
    await writeFile(script, "#!/bin/sh\ncase \"$1\" in\n  say) printf hi;;\n  fail) echo boom >&2; exit 3;;\nesac\n");
    await chmod(script, 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  };

  it("runs a real program without a shell and reports a failing one with its stderr", async () => {
    const env = await standInEnv();
    const run: Runner = (program, args, options) => spawnRunner()(program, args, { ...options, env });
    expect(await command(run, "git", ["say"])).toBe("hi");
    await expect(command(run, "git", ["fail"])).rejects.toThrow(/Command failed: git fail \(exit 3\)\nboom/);
    await expect(spawnRunner()("git", ["say"], { env: { PATH: "/nonexistent-dir" } })).rejects.toThrow("failed to start");
  });

  it("refuses a program outside the allowlist", async () => {
    await expect(command(spawnRunner(), "node", ["-e", "0"])).rejects.toThrow('refusing to run "node"');
    await expect(spawnRunner()("rm", ["-rf", "x"])).rejects.toThrow('refusing to run "rm"');
  });

  it("refuses to start once cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(spawnRunner({ signal: controller.signal })("git", ["say"])).rejects.toThrow("cancelled before it started");
  });
});

describe("parsePullRequestUrl", () => {
  it("accepts only an exact github.com pull request URL", () => {
    expect(parsePullRequestUrl(PR_URL)).toEqual({ owner: "o", repo: "r", number: 7 });
    for (const bad of [
      "https://github.com/o/r/pull/7/files",
      "https://github.com/o/r/pull/7?x=1",
      "http://github.com/o/r/pull/7",
      "https://github.com.evil.test/o/r/pull/7",
      "https://user@github.com/o/r/pull/7",
      "https://github.com/o/r/pull/0",
      "not a url",
    ]) {
      expect(() => parsePullRequestUrl(bad)).toThrow();
    }
  });
});

describe("github calls", () => {
  it("lists the changed files across pages and keeps a binary file's missing patch", async () => {
    const pages = `${COMPARE}${JSON.stringify({ files: [{ filename: "n.py", patch: "@@ -1 +1 @@\n+x" }] })}`;
    const { run, calls } = machine(() => ok(pages));
    const files = await changedFiles(ghOver(run), PR);
    expect(files.map((file) => file.filename)).toEqual(["m.py", "logo.png", "n.py"]);
    expect(files[1]).toEqual({ filename: "logo.png" });
    expect(calls[0]!.args).toEqual(["api", "--paginate", `repos/o/r/compare/${BASE_SHA}...${HEAD_SHA}?per_page=100`]);
  });

  it("reads every page of review threads, not only the first 100", async () => {
    const thread = (id: string) => ({ id, isResolved: false, comments: { nodes: [{ body: `b-${id}`, originalCommit: { oid: BASE_SHA } }] } });
    const page = (nodes: unknown[], more: boolean) =>
      JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: more, endCursor: "c" } } } } } });
    const { run, calls } = machine(() => ok(`${page([thread("t1"), thread("t2")], true)}\n${page([thread("t3")], false)}`));
    const threads = await openThreads(ghOver(run), PR);
    expect(threads.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
    expect(calls[0]!.args).toContain("--paginate");
    expect(calls[0]!.args.join(" ")).toContain("$endCursor");
  });

  it("skips a thread with no comment or no originating commit, and rejects a malformed answer", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: "a", isResolved: false, comments: { nodes: [] } },
                { id: "b", isResolved: false, comments: { nodes: [{ body: "x", originalCommit: null }] } },
              ],
            },
          },
        },
      },
    });
    expect(await openThreads(ghOver(machine(() => ok(page)).run), PR)).toEqual([]);
    await expect(openThreads(ghOver(machine(() => ok("{}")).run), PR)).rejects.toThrow("expected an object");
  });

  it("refuses a PR that is not open, or one GitHub answers for under another identity", async () => {
    const view = (over: Record<string, unknown>) => ok(JSON.stringify({ ...JSON.parse(PR_VIEW), ...over }));
    await expect(getPullRequest(ghOver(machine(() => view({ state: "MERGED" })).run), PR_URL)).rejects.toThrow("not open");
    await expect(getPullRequest(ghOver(machine(() => view({ url: "https://github.com/o/r/pull/8" })).run), PR_URL)).rejects.toThrow(
      "different PR",
    );
    await expect(getPullRequest(ghOver(machine(() => view({ headRefOid: "abc" })).run), PR_URL)).rejects.toThrow("40-character");
    expect(await getPullRequest(ghOver(machine(() => view({ body: null })).run), PR_URL)).toMatchObject({ description: "", headSha: HEAD_SHA });
  });

  it("passes the abort signal to every gh call", async () => {
    const controller = new AbortController();
    const { run, calls } = machine(() => ok(COMPARE));
    await changedFiles(ghOver(run, controller.signal), PR);
    expect(calls[0]!.options.signal).toBe(controller.signal);
  });
});

// ---- reviewers ---------------------------------------------------------------------------------------------------

/** The git and clone plumbing every reviewer needs, answered as a clean clone of the pinned snapshot. */
function plumbing(call: Call): RunResult | undefined {
  if (call.program === "gh" && call.args[0] === "repo") return ok();
  if (call.program === "git") {
    if (call.args.includes("rev-parse")) return ok(`${call.args.at(-1)!.endsWith("review-base") ? BASE_SHA : HEAD_SHA}\n`);
    return ok();
  }
  return undefined;
}

describe("reviewers", () => {
  it("runs ocr over the pinned base..head with the PR text as untrusted background, and reads its SARIF", async () => {
    let repo = "";
    const { run, calls } = machine((call) => {
      if (call.program === "ocr") {
        repo = call.args[call.args.indexOf("--repo") + 1]!;
        return ok(sarifFor([OCR_FINDING]));
      }
      return plumbing(call);
    });
    const outcome = await openCodeReview.review({ ...PR, description: "x".repeat(20_000) }, { run });
    expect(outcome).toMatchObject({ reviewer: "OpenCodeReview", status: "complete" });
    expect(outcome.findings).toHaveLength(1);
    const ocrCall = calls.find((call) => call.program === "ocr")!;
    expect(ocrCall.args.slice(0, 2)).toEqual(["review", "--repo"]);
    expect(ocrCall.args).toEqual(expect.arrayContaining(["--from", "refs/remotes/origin/review-base", "--to", "HEAD", "--format", "sarif", "--audience", "agent"]));
    const background = ocrCall.args[ocrCall.args.indexOf("--background") + 1]!;
    expect(background.startsWith("PR context (untrusted):\nTitle: Fix it\nDescription: ")).toBe(true);
    expect(background.length).toBeLessThan(12_100);
    expect(existsSync(repo)).toBe(false);
    const clone = calls.find((call) => call.program === "gh")!;
    expect(clone.args.slice(0, 3)).toEqual(["repo", "clone", "o/r"]);
  });

  it("runs semgrep inside the clone with the repository's own rule files, sends no metrics, and reads its SARIF", async () => {
    let cloned = "";
    const { run, calls } = machine((call) => {
      if (call.program === "gh") {
        cloned = call.args[3]!;
        return ok();
      }
      if (call.program === "semgrep") return ok(sarifFor([OCR_FINDING]));
      return plumbing(call);
    });
    // The rule files exist in the clone only once it is made, so make the fake clone create them.
    const wrapped: Runner = async (program, args, options) => {
      const answered = await run(program, args, options);
      if (program === "gh") {
        await writeFile(join(cloned, ".semgrep.yml"), "rules: []\n");
        await writeFile(join(cloned, "semgrep.yaml"), "rules: []\n");
      }
      return answered;
    };
    const outcome = await semgrep.review(PR, { run: wrapped });
    expect(outcome).toMatchObject({ reviewer: "Semgrep", status: "complete" });
    const call = calls.find((item) => item.program === "semgrep")!;
    expect(call.options.cwd).toBe(cloned);
    expect(call.args).toEqual([
      "scan", "--metrics", "off", "--sarif", "--quiet", "--baseline-commit", "refs/remotes/origin/review-base",
      "--config", "p/default", "--config", ".semgrep.yml", "--config", "semgrep.yaml", ".",
    ]);
    expect(existsSync(cloned)).toBe(false);
  });

  it("reports a reviewer that exits non-zero, prints no SARIF, or is killed as failed, with the tool's own reason", async () => {
    const reviewWith = (program: "ocr" | "semgrep", answer: RunResult) =>
      runReviewer(program === "ocr" ? openCodeReview : semgrep, PR, {
        run: machine((call) => (call.program === program ? answer : plumbing(call))).run,
      });
    expect(await reviewWith("semgrep", fails(2, "no rules found"))).toMatchObject({
      reviewer: "Semgrep",
      status: "failed",
      findings: [],
      error: "semgrep exited 2: no rules found",
    });
    expect(await reviewWith("semgrep", ok("not json"))).toMatchObject({ status: "failed", error: expect.stringContaining("did not print a SARIF log") });
    expect(await reviewWith("ocr", fails(1, 'boom {"message":"402 Payment Required"}'))).toMatchObject({
      status: "failed",
      error: "ocr exited 1: 402 Payment Required",
    });
    expect(await reviewWith("ocr", { code: -1, stdout: "", stderr: "", killed: true })).toMatchObject({
      status: "failed",
      error: "ocr was killed after 60 minutes",
    });
  });

  it("treats a SARIF log that reports an error as a failed review, not a clean one", async () => {
    const broken = sarifFor([], [{ executionSuccessful: true, toolExecutionNotifications: [{ level: "error", message: { text: "baseline broke" } }] }]);
    const outcome = await runReviewer(semgrep, PR, { run: machine((call) => (call.program === "semgrep" ? ok(broken) : plumbing(call))).run });
    expect(outcome).toMatchObject({ status: "failed", error: "SARIF run did not finish: baseline broke" });
  });

  it("fails when the PR moved between reading it and cloning it, and still removes the clone", async () => {
    let cloned = "";
    const { run } = machine((call) => {
      if (call.program === "gh") {
        cloned = call.args[3]!;
        return ok();
      }
      if (call.program === "git" && call.args.includes("rev-parse")) return ok(`${"9".repeat(40)}\n`);
      return plumbing(call);
    });
    const outcome = await runReviewer(openCodeReview, PR, { run });
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("Pull request changed while preparing its review") });
    expect(existsSync(cloned)).toBe(false);
  });

  it("rethrows a cancellation instead of reporting it as a reviewer failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = machine(() => ok());
    await expect(runReviewer(openCodeReview, PR, { run: never.run, signal: controller.signal })).rejects.toThrow();
  });
});

// ---- the whole run -----------------------------------------------------------------------------------------------

/** A fake GitHub + clone + reviewers world for `reviewPr`; `existing` is what an earlier run left on the PR. */
function world(
  options: {
    existing?: { comments?: string[]; reviews?: string[]; summary?: { id: number; node_id: string; body: string; html_url: string }; threads?: string };
    ocr?: RunResult;
    semgrep?: RunResult;
    view?: string;
  } = {},
) {
  const posted: Record<string, unknown>[] = [];
  const mutations: string[] = [];
  const repos: string[] = [];
  const m = machine(async (call) => {
    const plumb = plumbing(call);
    if (call.program === "gh" && call.args[0] === "repo") {
      repos.push(call.args[3]!);
      return ok();
    }
    if (plumb) return plumb;
    if (call.program === "ocr") return options.ocr ?? ok(sarifFor([OCR_FINDING]));
    if (call.program === "semgrep") return options.semgrep ?? ok(sarifFor([]));
    if (call.program !== "gh") return undefined;
    if (call.args[0] === "pr") return ok(options.view ?? PR_VIEW);
    if (has(call, "/compare/")) return ok(COMPARE);
    if (has(call, "--method", "POST")) {
      posted.push(JSON.parse(await readFile(call.args[call.args.indexOf("--input") + 1]!, "utf8")) as Record<string, unknown>);
      return ok(JSON.stringify({ id: 99, html_url: "https://github.com/o/r/pull/7#pullrequestreview-99" }));
    }
    if (has(call, "graphql")) {
      if (has(call, "reviewThreads")) return ok(options.existing?.threads ?? THREADS_NONE);
      mutations.push(call.args.filter((arg) => arg.startsWith("query=") || arg.startsWith("id=")).join(" "));
      return ok("{}");
    }
    if (has(call, "/comments?")) return ok((options.existing?.comments ?? []).map((body) => JSON.stringify(body)).join("\n"));
    if (has(call, "/reviews?") && has(call, "select")) {
      const summary = options.existing?.summary;
      return ok(summary ? JSON.stringify(summary) : "");
    }
    if (has(call, "/reviews?")) return ok((options.existing?.reviews ?? []).map((body) => JSON.stringify(body)).join("\n"));
    return undefined;
  });
  return { ...m, posted, mutations, repos };
}

describe("reviewPr", () => {
  it("reads the PR, runs both reviewers, and posts one COMMENT review on the pinned head with an inline thread", async () => {
    const w = world();
    const phases: string[] = [];
    const output = await reviewPr(PR_URL, { run: w.run, progress: (phase) => phases.push(phase) });

    expect(output).toMatchObject({
      url: PR_URL,
      head_sha: HEAD_SHA,
      review: { posted: true, id: 99, html_url: "https://github.com/o/r/pull/7#pullrequestreview-99", inline: 1, in_summary: 0, already_posted: 0, updated: false, resolved: 0 },
    });
    expect(output.reviewers.map((result) => [result.reviewer, result.status, result.findings.length])).toEqual([
      ["OpenCodeReview", "complete", 1],
      ["Semgrep", "complete", 0],
    ]);
    expect(w.posted).toHaveLength(1);
    const request = w.posted[0]! as { commit_id: string; event: string; body: string; comments: { path: string; line: number; side: string; body: string }[] };
    expect(request.commit_id).toBe(HEAD_SHA);
    expect(request.event).toBe("COMMENT");
    expect(request.body).toContain("## Automated code review");
    expect(request.body).toContain(summaryMark(HEAD_SHA));
    expect(request.comments).toHaveLength(1);
    expect(request.comments[0]).toMatchObject({ path: "m.py", line: 21, side: "RIGHT", start_line: 20 });
    expect(request.comments[0]!.body).toContain("<!-- review_pr:finding ");
    expect(phases).toEqual(["reading the pull request", "running OpenCodeReview and Semgrep", "attaching the review to the pull request"]);
    expect(w.repos).toHaveLength(2);
    for (const repo of w.repos) expect(existsSync(repo)).toBe(false);
    expect(outcomeText(output)).toContain("posted review https://github.com/o/r/pull/7#pullrequestreview-99");
  });

  it("posts nothing new on a rerun, replaces its summary body, and resolves a thread whose finding is gone", async () => {
    const first = world();
    await reviewPr(PR_URL, { run: first.run });
    const sent = first.posted[0]! as { body: string; comments: { body: string }[] };
    const staleThread = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-old",
                  isResolved: false,
                  comments: { nodes: [{ body: "_OpenCodeReview_\n\n<!-- review_pr:finding abcdef0123456789 -->", originalCommit: { oid: BASE_SHA } }] },
                },
              ],
            },
          },
        },
      },
    });
    const second = world({
      existing: {
        comments: sent.comments.map((comment) => comment.body),
        reviews: [sent.body],
        summary: { id: 99, node_id: "NODE99", body: sent.body, html_url: "https://github.com/o/r/pull/7#pullrequestreview-99" },
        threads: staleThread,
      },
    });
    const output = await reviewPr(PR_URL, { run: second.run });

    expect(output.review).toEqual({
      posted: false,
      id: 99,
      html_url: "https://github.com/o/r/pull/7#pullrequestreview-99",
      inline: 0,
      in_summary: 0,
      already_posted: 1,
      updated: true,
      resolved: 1,
    });
    expect(second.posted).toEqual([]);
    expect(second.mutations).toHaveLength(2);
    expect(second.mutations[0]).toContain("updatePullRequestReview");
    expect(second.mutations[0]).toContain("id=NODE99");
    expect(second.mutations[1]).toContain("resolveReviewThread");
    expect(second.mutations[1]).toContain("id=thread-old");
  });

  it("posts only the new findings as a follow-up when this tool's summary is already on the PR", async () => {
    const first = world({ ocr: ok(sarifFor([])) });
    await reviewPr(PR_URL, { run: first.run });
    const sent = first.posted[0]! as { body: string };
    const second = world({
      existing: { reviews: [sent.body], summary: { id: 5, node_id: "N5", body: sent.body, html_url: "u" } },
    });
    const output = await reviewPr(PR_URL, { run: second.run });
    expect(output.review).toMatchObject({ posted: true, inline: 1, updated: true });
    expect((second.posted[0] as { body: string }).body).toBe(`New findings on \`${HEAD_SHA.slice(0, 7)}\`.`);
  });

  it("still attaches when one reviewer fails, and says so", async () => {
    const w = world({ semgrep: fails(2, "no rules found") });
    const output = await reviewPr(PR_URL, { run: w.run });
    expect(output.reviewers[1]).toMatchObject({ reviewer: "Semgrep", status: "failed", error: "semgrep exited 2: no rules found" });
    expect(output.review.posted).toBe(true);
    expect((w.posted[0] as { body: string }).body).toContain("| Semgrep | failed: semgrep exited 2: no rules found | 0 |");
  });

  it("throws and writes nothing to the PR when every reviewer failed", async () => {
    const w = world({ ocr: fails(1, "no key"), semgrep: fails(2, "no rules found") });
    await expect(reviewPr(PR_URL, { run: w.run })).rejects.toThrow("every reviewer failed: OpenCodeReview: ocr exited 1: no key; Semgrep: semgrep exited 2: no rules found");
    expect(w.posted).toEqual([]);
    expect(w.mutations).toEqual([]);
  });

  it("refuses a closed PR before any reviewer runs or clones", async () => {
    const w = world({ view: JSON.stringify({ ...JSON.parse(PR_VIEW), state: "CLOSED" }) });
    await expect(reviewPr(PR_URL, { run: w.run })).rejects.toThrow("Pull request is not open");
    expect(w.calls.map((call) => call.program)).toEqual(["gh"]);
  });

  it("refuses a malformed URL before calling anything", async () => {
    const w = world();
    await expect(reviewPr("https://example.com/x", { run: w.run })).rejects.toThrow("Expected");
    expect(w.calls).toEqual([]);
  });
});

// ---- the tool ----------------------------------------------------------------------------------------------------

/** A stand-in for `pi.zod`: every method chains, which is all the factory needs to build its schema. */
const chain: unknown = new Proxy(function () {}, { get: () => chain, apply: () => chain });
type Pi = Parameters<CustomToolFactory>[0];

interface Tool {
  name: string;
  description: string;
  execute(id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal: undefined): Promise<unknown>;
}
const tool = factory({ zod: chain } as unknown as Pi) as unknown as Tool;

describe("the tool", () => {
  it("is named review_pr and describes itself in 80 to 250 words, saying it writes to the PR", () => {
    expect(tool.name).toBe("review_pr");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(tool.description).toContain("WRITES TO THE PR");
  });

  it("refuses an unsupported URL before running anything", async () => {
    await expect(tool.execute("id", { url: "https://github.com/o/r/pull/7/files" }, undefined, undefined, undefined)).rejects.toThrow(
      "Expected https://github.com/OWNER/REPO/pull/NUMBER",
    );
  });
});

describe("a reviewer's checkout directory", () => {
  it("is a fresh private directory per reviewer", async () => {
    const dirs = new Set<string>();
    const run: Runner = async (program, args) => {
      if (program === "gh" && args[0] === "repo") dirs.add(args[3]!);
      return plumbing({ program, args, options: {} }) ?? ok(sarifFor([]));
    };
    await Promise.all([openCodeReview.review(PR, { run }), semgrep.review(PR, { run })]);
    expect(dirs.size).toBe(2);
  });
});
