import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { COMMIT_SUBJECT_CAP, FIX_MODEL_ROLE, LOG_TAIL_CHARS } from "./constants.js";
import { arr, bool, obj, parseJson, str } from "./decode.js";
import { askJson } from "./omp_model.js";
import type { PrPorts } from "./ports.js";
import type { Attempt, Facts, Issue } from "./types.js";

export interface Edit {
  path: string;
  old: string;
  new: string;
}

export interface FixReply {
  can_fix: boolean;
  summary: string;
  edits: Edit[];
}

/** The reply schema the model is shown. The reply is checked in code (`validateReply`), never trusted to match it. */
const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["can_fix", "summary", "edits"],
  properties: {
    can_fix: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "old", "new"],
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      },
    },
  },
};

const INSTRUCTIONS =
  "A pull request has something open, usually a red check, and that failure is not the dependency upgrade. "
  + "Read the failed log. If the failure is outside this repository (a missing token in a platform job, a check this repo does not own), "
  + "say so, set can_fix false, and return no edits. If it is in this repository, name the smallest edit that makes that check pass: "
  + "each edit is one file, the exact text to replace, and the text that replaces it. "
  + "Never weaken a test. Never delete an assertion to go green. This is one attempt; the pull request is read again after it, "
  + "and you are asked again about whatever is still open, with what the earlier attempt did. Do not repeat an edit that did not fix it. "
  + "The summary says what you changed, or why you did not.";

/** The full prompt of one round. `open` is what is still open; `earlier` is what the last attempt did, or empty. */
export function fixPrompt(url: string, open: string, earlier: string): string {
  const before = earlier === "" ? "" : `\n\nAn earlier attempt on this pull request: ${earlier}`;
  return [
    INSTRUCTIONS,
    "",
    `url: ${url}\n${open}${before}`,
    "",
    `Answer with only one JSON object, no prose and no code fence, that matches this JSON Schema: ${JSON.stringify(REPLY_SCHEMA)}`,
  ].join("\n");
}

const ASSERTION = /expect|assert|it\(/;

/** Why `path` cannot be edited, or undefined. A path leaves the worktree when it is absolute or has a `..` segment; `.git` is never edited. */
function refusedPath(path: string): string | undefined {
  if (path === "" || isAbsolute(path) || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return `refuse path ${path}`;
  const segments = path.split(/[\\/]/);
  if (segments.includes("..")) return `refuse path ${path}`;
  if (segments.includes(".git")) return `refuse path ${path}: .git is never edited`;
  return undefined;
}

/** Decodes and checks a model reply before anything is written. Throws a message the model is shown on the retry. */
export function validateReply(value: unknown): FixReply {
  const reply = obj(value, "reply");
  const canFix = bool(reply.can_fix, "reply.can_fix");
  const summary = str(reply.summary, "reply.summary");
  if (summary.trim() === "") throw new Error("say what you changed, or why you did not");
  const edits = arr(reply.edits, "reply.edits").map((entry, index): Edit => {
    const where = `reply.edits[${index}]`;
    const edit = obj(entry, where);
    return { path: str(edit.path, `${where}.path`), old: str(edit.old, `${where}.old`), new: str(edit.new, `${where}.new`) };
  });
  if (!canFix) return { can_fix: false, summary, edits: [] };
  if (edits.length === 0) throw new Error("a fix needs the file and the exact text it replaces");
  for (const edit of edits) {
    const refusal = refusedPath(edit.path);
    if (refusal !== undefined) throw new Error(refusal);
    if (edit.old === "" || edit.new === "") {
      throw new Error(`${edit.path} needs the text to replace and the text that replaces it`);
    }
    if (edit.new.length < edit.old.length && ASSERTION.test(edit.old) && !ASSERTION.test(edit.new)) {
      throw new Error("do not weaken a test to make the check pass");
    }
  }
  return { can_fix: true, summary, edits };
}

/** The run id in a check's link: `https://github.com/o/r/actions/runs/<id>/job/<id>`. */
const RUN_ID = /\/actions\/runs\/(\d+)/;

/** What `gh` reports of a failed check: the tail of its failed log, or why there is none to show. */
export async function failedCheckLog(
  ports: Pick<PrPorts, "gh">,
  repo: string,
  number: number,
  name: string,
): Promise<string> {
  try {
    const listed = arr(
      parseJson(await ports.gh(["pr", "checks", String(number), "--repo", repo, "--json", "name,link"]), "gh pr checks"),
      "gh pr checks",
    ).map((entry) => obj(entry, "gh pr checks entry"));
    const link = listed.find((check) => check.name === name)?.link;
    const runId = RUN_ID.exec(typeof link === "string" ? link : "")?.[1];
    if (runId === undefined) return "(no log: the check is not a GitHub Actions job)";
    return (await ports.gh(["run", "view", runId, "--repo", repo, "--log-failed"])).slice(-LOG_TAIL_CHARS);
  } catch (error) {
    return `(no log: ${(error as Error).message.split("\n")[0]})`;
  }
}

/** One open issue as the prompt's text. */
export async function describeIssue(issue: Issue, log: (name: string) => Promise<string>): Promise<string> {
  switch (issue.kind) {
    case "failed-check":
      return `check ${issue.name} is red:\n${await log(issue.name)}`;
    case "thread":
      return `review thread by ${issue.author} on ${issue.path}: ${issue.body}`;
    case "comment":
      return `comment by ${issue.author}: ${issue.body}`;
    case "merge-base":
      return `the branch does not merge cleanly with ${issue.baseRef}: ${issue.why}`;
    case "conflict":
      return `merge conflicts with ${issue.baseRef} in ${issue.files.join(", ")}`;
    case "push-refused":
      return `the last push was refused: ${issue.output}`;
  }
}

/** Whether `full` (an existing path) is inside `root`, after resolving symlinks on both. */
async function inside(root: string, full: string): Promise<boolean> {
  const part = relative(await realpath(root), await realpath(full));
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/**
 * Replaces each edit's `old` text once, in memory, and writes only if every edit applied: a path that leaves the
 * worktree (including through a symlink), a file that is missing, or an `old` that is not unique throws and writes
 * nothing. The replacement text is literal (`$&` and `$1` in it are not patterns). Returns the paths changed.
 */
export async function applyUniqueEdits(cwd: string, edits: readonly Edit[]): Promise<string[]> {
  const texts = new Map<string, string>();
  for (const edit of edits) {
    const refusal = refusedPath(edit.path);
    if (refusal !== undefined) throw new Error(refusal);
    const full = resolve(cwd, edit.path);
    let text = texts.get(full);
    if (text === undefined) {
      try {
        if (!(await inside(cwd, full))) throw new Error(`refuse path ${edit.path}: it resolves outside the worktree`);
        text = await readFile(full, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`missing ${edit.path}`);
        throw error;
      }
    }
    const parts = text.split(edit.old);
    if (parts.length !== 2) throw new Error(`${edit.path}: expected one match, found ${parts.length - 1}`);
    texts.set(full, parts.join(edit.new));
  }
  const changed: string[] = [];
  for (const edit of edits) {
    const full = resolve(cwd, edit.path);
    const text = texts.get(full);
    if (text === undefined) continue;
    await writeFile(full, text, "utf8");
    texts.delete(full);
    changed.push(edit.path);
  }
  return changed;
}

/** A commit subject from the model's summary: its first line, within the repository's usual cap. */
export function commitSubject(summary: string): string {
  const line = (summary.split("\n")[0] ?? "").trim().replace(/\s+/g, " ");
  const subject = `fix(ci): ${line}`;
  return subject.length <= COMMIT_SUBJECT_CAP ? subject : `${subject.slice(0, COMMIT_SUBJECT_CAP - 1).trimEnd()}…`;
}

export interface RoundResult {
  /** The model's summary of the round: what it changed, or why it could not. */
  summary: string;
  /** The model says the cause is outside this repository (or not fixable by an edit). */
  impossible: boolean;
  /** Files edited and committed this round. */
  changed: string[];
  /** The work to push; null when the model could not fix. */
  attempt: Attempt | null;
}

const firstLine = (error: unknown): string => String(error instanceof Error ? error.message : error).split("\n")[0] ?? "";

/**
 * One fix round: the model reads what is open and answers with exact edits (asked again, with the reason, when a reply
 * fails `validateReply`); the edits are applied to a clean checkout of the judged head and committed. Nothing is pushed
 * here. A round whose edits cannot be applied or committed comes back as an attempt with a `problem`, never a throw,
 * so the next round is told what failed. A reply that cannot fix returns `impossible` and touches no checkout.
 */
export async function fixOneRound(
  ports: Pick<PrPorts, "model" | "checkout" | "git" | "gh" | "progress">,
  input: { facts: Facts; check: { check: string; log: string }; issues: readonly Issue[]; number: number; earlier: string },
  signal?: AbortSignal,
): Promise<RoundResult> {
  const { facts, number } = input;
  const open = number === 1
    ? `check: ${input.check.check}\n\n${input.check.log}`
    : (await Promise.all(
      input.issues.map((issue) => describeIssue(issue, (name) => failedCheckLog(ports, facts.repo, facts.number, name))),
    )).join("\n\n");
  ports.progress(`round ${number}: asking the model for a fix`);
  const reply = await askJson(ports.model, fixPrompt(facts.prUrl, open, input.earlier), validateReply, { signal });
  if (!reply.can_fix) return { summary: reply.summary, impossible: true, changed: [], attempt: null };

  const base = { number, role: FIX_MODEL_ROLE, cwd: "", fromSha: facts.headSha, commits: 0 } as const;
  const failed = (problem: string, cwd = ""): RoundResult => ({
    summary: reply.summary,
    impossible: false,
    changed: [],
    attempt: { ...base, cwd, problem },
  });
  ports.progress(`round ${number}: applying ${reply.edits.length} edit${reply.edits.length === 1 ? "" : "s"}`);
  const cwd = await ports.checkout(facts.prUrl);
  const fromSha = (await ports.git(["rev-parse", "HEAD"], cwd)).trim();
  if (fromSha !== facts.headSha) {
    return failed(`the head moved since it was judged: checked out ${fromSha}, judged ${facts.headSha}`, cwd);
  }
  let changed: string[];
  try {
    changed = await applyUniqueEdits(cwd, reply.edits);
  } catch (error) {
    return failed(`the edits could not be applied: ${firstLine(error)}`, cwd);
  }
  try {
    await ports.git(["add", "--", ...changed], cwd);
    await ports.git(["commit", "-m", commitSubject(reply.summary)], cwd);
  } catch (error) {
    return failed(`the commit failed: ${firstLine(error)}`, cwd);
  }
  return { summary: reply.summary, impossible: false, changed, attempt: { ...base, cwd, commits: 1, problem: "" } };
}
