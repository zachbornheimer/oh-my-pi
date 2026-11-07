import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { gatherPullRequestSnapshot } from "./lib/gather_pr.js";
import { checkoutForPr, livePrPorts, runPrLoop } from "./loop/run.js";
import { parsePullRequestUrl } from "./loop/parse_url.js";
import { ompModelStep, RESEARCH_TIMEOUT_MS } from "./omp_model.js";
import type { UpgradeResult } from "./upgrade.js";
import { upgradeDependency } from "./upgrade.js";
import { liveUpgradeHost } from "./upgrade_host.js";

const HEARTBEAT_MS = 15_000;

/** The builtin omp tools the changelog and usage steps may call: read-only, on a checkout of the PR head. */
const RESEARCH_TOOLS = ["read", "grep", "find", "web_search"] as const;

export const DESCRIPTION =
  "Drive one dependency-upgrade pull request to ready: classify it, research the range and its callers, settle the lockfile, run the pull-request fix loop with the upgrade's gates, and arm automerge. "
  + "Use for a Renovate, Dependabot or hand-made version-bump PR you can push to; make_pr_mergable fixes any PR without the upgrade analysis. "
  + "Input `{\"url\":\"https://github.com/OWNER/REPO/pull/N\"}`, exact form. "
  + "A closed model reply classifies it `upgrade`, `config_only` (a bot's config file only) or `not_dependency`, which is reported `skipped` and touched in no way. "
  + "An upgrade runs five `omp -p` `@task` steps (packages, changelog, callers, facade plan, PR-body headings), each reply validated in code and re-asked up to 3 times; changelog and callers use read-only tools (read, grep, find, web_search) on a checkout. "
  + "The loop (target mergeable, NEVER merges) fixes red CI and failed gates `one_dependency_per_commit`, `lockfile_committed`, `tests_unweakened`, pushing commits to the PR branch (never forced; hooks run). "
  + "ONLY a loop that ended done with no failed gate labels `ai:dependencies-checked` and arms automerge. "
  + "Returns details `{url,kind,changes,changelog,usages,facade,body,gates:[{name,verdict,observed}],verdict:\"ready\"|\"needs_work\"|\"skipped\",seconds}`; an impossible or spent loop is `needs_work` with reasons in the `ci` gate. "
  + "Throws when the PR or its facts cannot be read or a model step never yields a valid reply. "
  + "Needs `gh`, `git`, `rg` and the ecosystem's lock tool (aube/pnpm/npm, go, mise) on PATH. Pushes, labels, arms automerge, spends model quota; takes minutes to hours; not resumable. Omits `--input` snapshot mode.";

/** The text a caller reads: the verdict, what was upgraded, and every gate. */
export function reportText(report: UpgradeResult): string {
  const lines = [`upgrade_dependency ${report.url}: ${report.verdict} (${report.kind}, ${report.seconds} s)`];
  if (report.changes.packages.length > 0) {
    lines.push(`upgrading: ${report.changes.packages.map((pkg) => `${pkg.name} ${pkg.from} → ${pkg.to}`).join(", ")}`);
  }
  for (const gate of report.gates) lines.push(`${gate.verdict} ${gate.name}: ${gate.observed}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "upgrade_dependency",
  label: "Upgrade dependency",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    url: pi.zod.string().url().describe(
      "Pull request URL, exactly `https://github.com/OWNER/REPO/pull/N` (no query, fragment or extra path).",
    ),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    parsePullRequestUrl(params.url);
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `upgrade_dependency: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const progress = (message: string): void => {
        phase = message;
      };
      const ports = livePrPorts({ signal, progress });
      const report = await upgradeDependency(
        {
          model: ompModelStep(pi.exec, { model: "@task" }),
          research: async (prUrl) =>
            ompModelStep(pi.exec, {
              model: "@task",
              tools: RESEARCH_TOOLS,
              cwd: await checkoutForPr({ signal })(prUrl),
              timeoutMs: RESEARCH_TIMEOUT_MS,
            }),
          host: liveUpgradeHost(params.url, signal),
          loop: (input) => runPrLoop(ports, input),
          gather: (prUrl) => gatherPullRequestSnapshot(prUrl, { checkout: checkoutForPr({ signal }), signal }),
          clock: Date.now,
          progress,
          signal,
        },
        params.url,
      );
      return { content: [{ type: "text", text: reportText(report) }], details: report };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
