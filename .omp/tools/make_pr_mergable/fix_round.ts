import { readFileSync } from "node:fs";
import { PR_BUDGET } from "./budget.js";
import {
  AGENT_NOT_RUN,
  AGENT_PUSH_URL,
  NAMED_FILES_CAP,
  PORCELAIN_PATH_OFFSET,
  ROUND_AGENT_BUDGET_MS,
  ROUND_BUDGET_EXIT,
  roleOfRound,
} from "./constants.js";
import type { PrPorts } from "./ports.js";
import type { Attempt, Facts, Issue } from "./types.js";

let template: string | undefined;

/** The prompt text lives next to this module and is read once. */
function promptTemplate(): string {
  template ??= readFileSync(new URL("./prompts/fix_round.md", import.meta.url), "utf8");
  return template;
}

/** The prompt of one round: the pull request, the base to merge if asked, and every issue as data. */
export function fixRoundPrompt(facts: Facts, issues: readonly Issue[]): string {
  return promptTemplate()
    .replaceAll("{{prUrl}}", facts.prUrl)
    .replaceAll("{{baseRef}}", facts.baseRef)
    .replaceAll("{{roundBudgetMinutes}}", String(ROUND_AGENT_BUDGET_MS / 60_000))
    .replaceAll("{{issues}}", JSON.stringify(issues, null, 2));
}

type RoundBase = Omit<Attempt, "problem" | "commits" | "agentStatus">;

function failed(base: RoundBase, problem: string): Attempt {
  return { ...base, commits: 0, agentStatus: AGENT_NOT_RUN, problem };
}

/** What the host's merge of `origin/<base>` into the head came to. */
type BaseMerge =
  | { kind: "merged" }
  | { kind: "unchanged" }
  | { kind: "conflicts"; files: string[] }
  | { kind: "failed"; reason: string };

/** The refs git leaves while a merge, rebase or cherry-pick is stopped, and what each is called in a reason. */
const UNFINISHED_OPERATIONS: readonly (readonly [ref: string, name: string])[] = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
];

const firstLine = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).split("\n")[0] ?? "";

/**
 * The host's merge of the base into the head: the one part of a base conflict git can do alone. A conflict is not a
 * failure: the merge stays started, and the files git could not merge go to the agent.
 */
async function mergeBaseIntoHead(ports: Pick<PrPorts, "git">, cwd: string, baseRef: string): Promise<BaseMerge> {
  const ref = `origin/${baseRef}`;
  try {
    await ports.git(["fetch", "--no-tags", "origin", `+refs/heads/${baseRef}:refs/remotes/${ref}`], cwd);
  } catch (error) {
    return { kind: "failed", reason: `fetching ${ref} failed: ${firstLine(error)}` };
  }
  const before = (await ports.git(["rev-parse", "HEAD"], cwd)).trim();
  try {
    await ports.git(["merge", "--no-edit", ref], cwd);
  } catch (error) {
    const files = (await ports.git(["diff", "--name-only", "--diff-filter=U"], cwd)).split("\n").filter((line) =>
      line !== ""
    );
    if (files.length > 0) return { kind: "conflicts", files };
    await ports.git(["merge", "--abort"], cwd).catch(() => undefined);
    return { kind: "failed", reason: `merging ${ref} failed: ${firstLine(error)}` };
  }
  const after = (await ports.git(["rev-parse", "HEAD"], cwd)).trim();
  return after === before ? { kind: "unchanged" } : { kind: "merged" };
}

/** Why the tree is not fit to push: a merge, rebase or cherry-pick still open, or files not committed. Empty when it is. */
async function untidyTree(ports: Pick<PrPorts, "git">, cwd: string): Promise<string[]> {
  const reasons: string[] = [];
  for (const [ref, name] of UNFINISHED_OPERATIONS) {
    const open = await ports.git(["rev-parse", "-q", "--verify", ref], cwd).then(() => true, () => false);
    if (open) reasons.push(`the tree was left mid-${name}`);
  }
  const changed = (await ports.git(["status", "--porcelain"], cwd)).split("\n").filter((line) => line !== "");
  if (changed.length > 0) {
    const shown = changed.slice(0, NAMED_FILES_CAP).map((line) => line.slice(PORCELAIN_PATH_OFFSET));
    const more = changed.length > shown.length ? ` and ${changed.length - shown.length} more` : "";
    reasons.push(`the tree was left with uncommitted changes: ${shown.join(", ")}${more}`);
  }
  return reasons;
}

/**
 * Runs omp's role for round `number` in a private checkout of the head the facts describe. The checkout starts clean at
 * that head, whatever an earlier round left in the directory. The host merges `origin/<base>` itself when the issues
 * ask for it; only the conflicts git reports go to the agent, which resolves them and commits the merge. The checkout's
 * push URL points nowhere while the agent runs, so the agent can commit and cannot push. Returns how many commits the
 * round left; it does not push. A round whose agent crashed, exited non-zero, left the tree dirty or mid-merge, rewrote
 * history or left no commit comes back with a `problem`.
 */
export async function fixOpenPrIssuesOneCommitEachWithOmp(
  ports: Pick<PrPorts, "checkout" | "git" | "runAgent" | "progress">,
  input: { facts: Facts; issues: readonly Issue[]; number: number },
): Promise<Attempt> {
  if (input.number < 1 || input.number > PR_BUDGET.rounds) {
    throw new Error(`there is no fix round ${input.number}; rounds are 1..${PR_BUDGET.rounds}`);
  }
  const role = roleOfRound(input.number);
  if (input.facts.state !== "OPEN") {
    return failed(
      { number: input.number, role, cwd: "", fromSha: input.facts.headSha },
      `the pull request is ${input.facts.state.toLowerCase()}`,
    );
  }
  const cwd = await ports.checkout(input.facts.prUrl);
  const fromSha = (await ports.git(["rev-parse", "HEAD"], cwd)).trim();
  const base: RoundBase = { number: input.number, role, cwd, fromSha };
  if (fromSha !== input.facts.headSha) {
    return failed(base, `the head moved since it was judged: checked out ${fromSha}, judged ${input.facts.headSha}`);
  }
  await ports.git(["remote", "set-url", "--push", "origin", AGENT_PUSH_URL], cwd);
  try {
    return await runRound(ports, base, input);
  } finally {
    await ports.git(["config", "--unset-all", "remote.origin.pushurl"], cwd).catch(() => undefined);
  }
}

async function runRound(
  ports: Pick<PrPorts, "git" | "runAgent" | "progress">,
  base: RoundBase,
  input: { facts: Facts; issues: readonly Issue[] },
): Promise<Attempt> {
  const { cwd, fromSha, role } = base;
  const forAgent: Issue[] = [];
  let baseRef: string | undefined;
  let baseChangedNothing = false;
  for (const issue of input.issues) {
    if (issue.kind !== "merge-base") {
      forAgent.push(issue);
      continue;
    }
    baseRef = issue.baseRef;
    const merge = await mergeBaseIntoHead(ports, cwd, issue.baseRef);
    if (merge.kind === "failed") return failed(base, merge.reason);
    if (merge.kind === "conflicts") forAgent.push({ kind: "conflict", baseRef: issue.baseRef, files: merge.files });
    baseChangedNothing = merge.kind === "unchanged";
  }
  const problems: string[] = [];
  let agentStatus = AGENT_NOT_RUN;
  if (forAgent.length > 0) {
    // The host's wait on its round must read as a wait in the run's output, not as silent work.
    ports.progress(`round ${base.number} (${role}): waiting on omp, bounded at ${ROUND_AGENT_BUDGET_MS / 60_000} minutes`);
    try {
      agentStatus = await ports.runAgent({ cwd, role, prompt: fixRoundPrompt(input.facts, forAgent) });
      if (agentStatus === ROUND_BUDGET_EXIT) {
        problems.push(
          `omp ${role} was stopped at the ${ROUND_AGENT_BUDGET_MS / 60_000}-minute round budget: an idle round is stopped, never waited on; the next round starts from the same head`,
        );
      } else if (agentStatus !== 0) {
        problems.push(`omp ${role} exited ${agentStatus}`);
      }
    } catch (error) {
      problems.push(`omp ${role} crashed: ${firstLine(error)}`);
    }
  }
  problems.push(...await untidyTree(ports, cwd));
  const commits = Number((await ports.git(["rev-list", "--count", "--first-parent", `${fromSha}..HEAD`], cwd)).trim());
  const attempt = (problem: string): Attempt => ({ ...base, commits, agentStatus, problem });
  if (problems.length > 0) return attempt(problems.join("; "));
  const descends = await ports.git(["merge-base", "--is-ancestor", fromSha, "HEAD"], cwd).then(() => true, () => false);
  if (!descends) return attempt("the agent rewrote history: the judged head is not an ancestor");
  if (commits >= 1) return attempt("");
  if (forAgent.length === 0 && baseChangedNothing) {
    return attempt(`merging origin/${baseRef} changed nothing: the head already contains it`);
  }
  return attempt(`omp ${role} made no commit`);
}
