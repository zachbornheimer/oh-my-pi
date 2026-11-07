import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileCheckpoints } from "./checkpoint.js";
import {
  ASK_BUDGET_MS,
  CHECKPOINT_DIR,
  CLONE_BUDGET_MS,
  DELEGATE_DIR,
  FIX_RED_CI_BUDGET_MS,
  GH_BUDGET_MS,
  GIT_BUDGET_MS,
  GIT_PUSH_BUDGET_MS,
  IMPLEMENT_BUDGET_MS,
  LOCK_FILE,
  MAKE_PR_MERGABLE_BUDGET_MS,
  MAKE_PR_MERGABLE_TARGET,
  OMP_DEFAULT_MODEL,
  REVIEW_BUDGET_MS,
  REVIEW_WITHOUT_CHECKOUT_DIR,
  REVIEWER_MODEL,
  UPGRADE_DEPENDENCY_BUDGET_MS,
  WORK_BUDGET_MS,
  WORK_WITHOUT_CHECKOUT_DIR,
} from "./constants.js";
import { command, type Runner, sleep, spawnRunner } from "./exec.js";
import { fileLock } from "./file_lock.js";
import { githubPort } from "./github_port.js";
import { linearPort } from "./linear_port.js";
import { clearVerdictFile, readVerdictFile, runOmp } from "./omp_run.js";
import type { FactoryPorts, UpgradeReport } from "./ports.js";
import { repoPort } from "./repo_port.js";
import { FactoryRunLedger } from "./run_ledger.js";
import { arr, bool, type Infer, obj, oneOf, opt, str } from "./shape.js";
import { fillTemplate, parseAnswer, schemaText } from "./template.js";
import { prompt } from "./prompt_files.js";

/** `gh` and `git` read the shell's credentials, plus the `gh` login's token for a push whose hooks read GitHub. */
async function pushEnv(run: Runner, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const token = (await command(run, "gh", ["auth", "token"], { timeoutMs: GH_BUDGET_MS }).catch(() => "")).trim();
  return token === "" ? base : { ...base, GITHUB_TOKEN: token, GH_TOKEN: token };
}

/** The relay's reply: `called` false when the delegated tool was not there or failed before it ran. */
const relayShape = obj({
  called: bool(),
  why: opt(str()),
  status: opt(str()),
  verdict: opt(str()),
  green: opt(bool()),
  summary: opt(str()),
  reasons: opt(arr(str())),
});
type Relay = ReturnType<typeof relayShape.parse>;

/**
 * Calls one sibling omp tool through a headless full omp session that holds every installed tool: a tool cannot call
 * another tool directly, so a relay session does it once and answers the tool's own result as JSON. A relay that could
 * not call the tool is an error naming the missing tool, never a guess at its answer.
 */
async function relay(
  run: Runner,
  input: { tool: string; task: string; shape: string; budgetMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<Relay> {
  await mkdir(DELEGATE_DIR, { recursive: true });
  const text = fillTemplate(prompt("delegate_tool.md"), { tool: input.tool, task: input.task, shape: input.shape }, "delegate_tool.md");
  const reply = await runOmp(run, {
    cwd: DELEGATE_DIR,
    prompt: text,
    model: OMP_DEFAULT_MODEL,
    bare: false,
    budgetMs: input.budgetMs,
    label: `the ${input.tool} relay`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const answer = parseAnswer(reply, relayShape, `the ${input.tool} relay`);
  if (!answer.called) {
    throw new Error(`the omp tool ${input.tool} could not be called from this machine: ${answer.why ?? "no reason given"}`);
  }
  return answer;
}

export type LivePortOptions = {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
};

/** The real Linear, GitHub, git, omp sessions, sibling tools, lock, ledger and checkpoints. */
export function livePorts(options: LivePortOptions = {}): FactoryPorts {
  const env = options.env ?? process.env;
  const signal = options.signal;
  const run = options.run ?? spawnRunner(signal === undefined ? {} : { signal });
  const gh = (args: readonly string[]) => command(run, "gh", args, { timeoutMs: GH_BUDGET_MS, env });
  const git = async (args: readonly string[], cwd: string) =>
    args[0] === "push"
      ? command(run, "git", ["-C", cwd, ...args], { timeoutMs: GIT_PUSH_BUDGET_MS, env: await pushEnv(run, env) })
      : command(run, "git", ["-C", cwd, ...args], { timeoutMs: GIT_BUDGET_MS, env });
  const github = githubPort(gh);

  return {
    linear: linearPort({ env, ...(signal === undefined ? {} : { signal }) }),
    github,
    repos: repoPort({
      git,
      clone: async (repo, destination) => {
        await command(run, "gh", ["repo", "clone", `${repo.org}/${repo.name}`, destination], { timeoutMs: CLONE_BUDGET_MS, env });
      },
    }),
    sleep: (ms) => sleep(ms, signal),
    readSkill: (name) => readFile(join(homedir(), ".agents", "skills", name, "SKILL.md"), "utf8"),
    ask: ({ field, prompt: text }) =>
      runOmp(run, { prompt: text, bare: true, budgetMs: ASK_BUDGET_MS, label: `the ${field} question`, ...(signal === undefined ? {} : { signal }) }),
    implement: ({ worktree, prompt: text }) =>
      runOmp(run, {
        cwd: worktree,
        prompt: text,
        model: OMP_DEFAULT_MODEL,
        bare: false,
        budgetMs: IMPLEMENT_BUDGET_MS,
        label: "the implementer",
        ...(signal === undefined ? {} : { signal }),
      }),
    async workWithoutCheckout({ prompt: text }) {
      await mkdir(WORK_WITHOUT_CHECKOUT_DIR, { recursive: true });
      return runOmp(run, {
        cwd: WORK_WITHOUT_CHECKOUT_DIR,
        prompt: text,
        model: OMP_DEFAULT_MODEL,
        bare: false,
        budgetMs: WORK_BUDGET_MS,
        label: "the ticket worker",
        ...(signal === undefined ? {} : { signal }),
      });
    },
    async review({ worktree, prompt: text, verdictPath }) {
      await clearVerdictFile(verdictPath);
      // A ticket with no repository has no checkout to read: its reviewer runs in a scratch directory instead.
      const cwd = worktree ?? REVIEW_WITHOUT_CHECKOUT_DIR;
      if (worktree === undefined) await mkdir(cwd, { recursive: true });
      await runOmp(run, {
        cwd,
        prompt: text,
        model: REVIEWER_MODEL,
        bare: false,
        budgetMs: REVIEW_BUDGET_MS,
        label: `the reviewer (${REVIEWER_MODEL})`,
        ...(signal === undefined ? {} : { signal }),
      });
      return readVerdictFile(verdictPath);
    },
    async makePrMergable({ prUrl, merge }) {
      const shape = obj({ called: bool(), status: str(), reasons: arr(str()) });
      const answer = await relay(run, {
        tool: "make_pr_mergable",
        task: `Input: {"prUrl":${JSON.stringify(prUrl)},"target":${JSON.stringify(MAKE_PR_MERGABLE_TARGET)},"merge":${merge},"dryRun":false}`,
        shape: `${schemaText(shape)}\n\n\`status\` is the tool's status word (merged, done, queued, impossible, spent or working); \`reasons\` are its reasons.`,
        budgetMs: MAKE_PR_MERGABLE_BUDGET_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (answer.status === undefined) throw new Error(`make_pr_mergable answered no status for ${prUrl}`);
      return { status: answer.status, reasons: answer.reasons ?? [] };
    },
    async upgradeDependency({ prUrl }): Promise<UpgradeReport> {
      const shape = obj({ called: bool(), verdict: oneOf(["ready", "needs_work", "skipped"] as const), reasons: arr(str()) });
      const answer = await relay(run, {
        tool: "upgrade_dependency",
        task: `Run it on the dependency bot's pull request ${prUrl}. It labels a done pull request checked and arms automerge; it never merges. If its input needs more than the URL, read the tool's description for what to pass.`,
        shape: `${schemaText(shape)}\n\n\`verdict\` is \`ready\` only when the tool says the pull request is labeled checked and armed for automerge; \`reasons\` are the failed gates' observations.`,
        budgetMs: UPGRADE_DEPENDENCY_BUDGET_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (answer.verdict !== "ready" && answer.verdict !== "needs_work" && answer.verdict !== "skipped") {
        throw new Error(`upgrade_dependency answered no usable verdict for ${prUrl}: ${answer.verdict ?? "none"}`);
      }
      return { verdict: answer.verdict, reasons: answer.reasons ?? [] };
    },
    async fixRedCi({ prUrl }) {
      const where = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
      if (where === null) throw new Error(`not a pull request URL: ${prUrl}`);
      const checks = JSON.parse(await gh(["pr", "checks", where[3]!, "--repo", `${where[1]}/${where[2]}`, "--json", "name,bucket"])) as { name: string; bucket: string }[];
      const failed = checks.find((check) => check.bucket === "fail");
      // fix_red_ci's own loop answers done with no round when no check is red, so no relay is paid for here either.
      if (failed === undefined) return { green: true, report: "The pull request has no failed check." };
      const shape = obj({ called: bool(), green: bool(), status: str(), summary: str(), reasons: arr(str()) });
      const answer = await relay(run, {
        tool: "fix_red_ci",
        task: `Run it on the pull request ${prUrl}, whose check \`${failed.name}\` is red and belongs to this repository. Fetch that check's failure log with \`gh\` (\`gh run view --log-failed\`) if the tool needs it.`,
        shape: `${schemaText(shape)}\n\n\`green\` is true only when the tool says the pull request is mergeable; \`status\` is its status word (done, impossible or spent).`,
        budgetMs: FIX_RED_CI_BUDGET_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (answer.green === undefined) throw new Error(`fix_red_ci answered no verdict for ${prUrl}`);
      const report = [`${prUrl}: ${answer.status ?? "unknown"}`, answer.summary ?? "", ...(answer.reasons ?? []).map((reason) => `  - ${reason}`)].filter((line) => line !== "");
      return { green: answer.green, report: report.join("\n") };
    },
    lock: fileLock(LOCK_FILE),
    ledger: new FactoryRunLedger(),
    checkpoints: fileCheckpoints(CHECKPOINT_DIR),
    now: () => Date.now(),
  };
}
