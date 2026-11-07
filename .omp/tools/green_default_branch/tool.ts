import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import type { Ctx, DrivePr } from "./context.js";
import { makePrMergableDrive } from "./drive.js";
import { type Host, shellHost } from "./host.js";
import { parseTarget } from "./target.js";
import { ompUpgradeRunner, type UpgradeRunner } from "./upgrade_runner.js";
import { type RepositoryRun, runGreenDefaultBranch, runGreenRepositories, type SweepResult } from "./workflow.js";

function isTarget(text: string): boolean {
  try {
    parseTarget(text);
    return true;
  } catch {
    return false;
  }
}

const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Green GitHub repositories' default-branch CI end to end, then upgrade their open Dependabot and Renovate pull requests. "
  + "Use when a repository's default branch is red or its bot pull requests lack `ai:dependencies-checked`; one pull request belongs to make_pr_mergable, a dependency pull request on its own to upgrade_dependency. "
  + "Input `{\"target\":\"owner/name\",\"dryRun\":false}`. target is `owner/name`, `https://github.com/owner/name`, `all` (every repository the gh user can push to, minus the canary, archived, unpushable and billing-hold owners) or an owner login (that owner's). "
  + "dryRun true (default false) reads and records only. Repositories run three at a time, red first. "
  + "Per repository it reads the default branch's rollup, then records green, no-ci, queued, api-error or infra; reruns one flaky allowlisted job; or runs headless omp `/green` (`@task`, 45 minutes, 6 agent-hours a day) in a private clone on `ci-green/<date>`, pushes only that branch, opens its pull request and squash-merges it once settled approved (else make_pr_mergable's fix rounds). "
  + "A repository recorded green then gets the native upgrade_dependency tool run, through headless omp, on each bot pull request without the label. "
  + "State is kept in `~/Library/Application Support/repo-green` (events.jsonl). "
  + "Unless dryRun it clones, pushes, merges, labels and spends model quota. "
  + "Returns one `name: state (evidence)` line per repository plus upgrade verdicts, and `exitCode` 0 only when every repository ended green, no-ci, flaky-rerun or awaiting-merge; needs-human reasons are returned, nothing is posted. "
  + "Runs minutes to hours with progress updates; a rerun re-reads a merge left awaiting checks.";

/** What the tool depends on beyond `gh`, `git` and `omp`; tests substitute these. */
export type ToolDeps = {
  host?: (signal?: AbortSignal) => Host;
  upgrade?: (host: Host) => UpgradeRunner;
  drive?: (options: { signal?: AbortSignal; progress: (message: string) => void }) => DrivePr;
};

export type GreenDetails = (
  | { kind: "repository"; run: RepositoryRun }
  | { kind: "sweep"; sweep: SweepResult }
) & { target: string; dryRun: boolean; exitCode: number; seconds: number };

/** The text a caller reads: one line per repository, what needs a person, and each upgrade verdict. */
export function renderRun(run: RepositoryRun): string {
  const lines = [`${run.nameWithOwner}: ${run.state} (${run.evidence.replace(/\s+/g, " ").trim()})`];
  if (run.needsHuman !== undefined) lines.push(`  needs a person: ${run.needsHuman}`);
  if (run.skipped !== undefined) lines.push(`  upgrades skipped: ${run.skipped}`);
  for (const pull of run.pulls) lines.push(`  ${pull.url}: ${pull.verdict} (${pull.reason})`);
  return lines.join("\n");
}

function renderSweep(sweep: SweepResult): string {
  const detail = sweep.runs
    .filter((run) => run.needsHuman !== undefined || run.pulls.length > 0 || run.skipped !== undefined)
    .map((run) => renderRun(run).split("\n").slice(1).map((line) => `${run.nameWithOwner}: ${line.trim()}`).join("\n"))
    .filter((block) => block !== "");
  return [sweep.text, ...detail].join("\n");
}

export function buildTool(pi: CustomToolAPI, deps: ToolDeps = {}): CustomTool<any, GreenDetails> {
  const z = pi.zod;
  return {
    name: "green_default_branch",
    label: "Green default branch",
    description: DESCRIPTION,
    parameters: z.object({
      target: z.string().min(1).refine(isTarget, "target must be `all`, a GitHub owner login, `owner/name` or https://github.com/owner/name").describe(
        "`owner/name`, `https://github.com/owner/name`, an owner login (every pushable repository of that owner) or `all` (every pushable repository the gh user can read).",
      ),
      dryRun: z.boolean().nullable().optional().describe(
        "True records each repository's state and never reruns, fixes, merges or upgrades. Default false.",
      ),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const target = parseTarget(params.target);
      const dryRun = params.dryRun ?? false;
      const began = Date.now();
      let phase = "starting";
      const progress = (message: string): void => {
        phase = message;
      };
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `green_default_branch: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, HEARTBEAT_MS);
      try {
        const host = (deps.host ?? shellHost)(signal);
        const ctx: Ctx = {
          host,
          progress,
          upgrade: (deps.upgrade ?? ompUpgradeRunner)(host),
          drive: (deps.drive ?? makePrMergableDrive)({ signal, progress }),
        };
        const seconds = (): number => Math.round((Date.now() - began) / 1000);
        if (target.kind === "repository") {
          const run = await runGreenDefaultBranch(ctx, target.nameWithOwner, dryRun);
          return {
            content: [{ type: "text", text: `${renderRun(run)}\nexitCode ${run.exitCode}` }],
            details: { kind: "repository", run, target: params.target, dryRun, exitCode: run.exitCode, seconds: seconds() },
          };
        }
        const sweep = await runGreenRepositories(ctx, target.filter, dryRun);
        return {
          content: [{ type: "text", text: `${renderSweep(sweep)}\nexitCode ${sweep.exitCode}` }],
          details: { kind: "sweep", sweep, target: params.target, dryRun, exitCode: sweep.exitCode, seconds: seconds() },
        };
      } finally {
        clearInterval(beat);
      }
    },
  };
}
