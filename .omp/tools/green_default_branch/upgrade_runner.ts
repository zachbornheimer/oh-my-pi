import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_BIN, OMP_TASK_ROLE, UPGRADE_LIMIT_MS } from "./constants.js";
import type { Host } from "./host.js";

/** The name of the native omp tool that drives one atomic dependency upgrade on a pull request. */
export const UPGRADE_TOOL = "upgrade_dependency";

export type UpgradeVerdict = "ready" | "needs_work" | "skipped";

/** What one `upgrade_dependency` call settled on: its verdict and the `name: observed` of each gate that failed. */
export type UpgradeReport = { verdict: UpgradeVerdict; failed: string[] } | { error: string };

/** Runs `upgrade_dependency` on one pull request. Tests substitute this. */
export type UpgradeRunner = (prUrl: string) => Promise<UpgradeReport>;

function upgradePrompt(prUrl: string): string {
  return [
    `Call the \`${UPGRADE_TOOL}\` tool exactly once with {"url":"${prUrl}"}.`,
    "Use no other tool, edit nothing yourself, and call it for no other pull request.",
    "When it returns, reply with the single word done.",
  ].join("\n");
}

/**
 * The verdict of the one `upgrade_dependency` call in an `omp --mode json` event stream. The stream is machine output:
 * the verdict is the tool's own `details`, never words the model wrote. A stream without a settled call, a call that
 * errored, or details of another shape is an error.
 */
export function reportOfEvents(stdout: string): UpgradeReport {
  let ended: { result?: unknown; isError?: unknown } | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "tool_execution_end" || event.toolName !== UPGRADE_TOOL) continue;
    ended = { result: event.result, isError: event.isError };
  }
  if (ended === undefined) return { error: `omp never finished a ${UPGRADE_TOOL} call` };
  const result = isRecord(ended.result) ? ended.result : {};
  if (ended.isError === true || result.isError === true) {
    return { error: `${UPGRADE_TOOL} failed: ${textOf(result.content).slice(0, 300)}` };
  }
  const details = isRecord(result.details) ? result.details : undefined;
  const verdict = details?.verdict;
  if (verdict !== "ready" && verdict !== "needs_work" && verdict !== "skipped") {
    return { error: `${UPGRADE_TOOL} returned no verdict` };
  }
  const gates = Array.isArray(details?.gates) ? details.gates : [];
  const failed = gates
    .filter((gate): gate is Record<string, unknown> => isRecord(gate) && gate.verdict === "failed")
    .map((gate) => `${String(gate.name)}: ${String(gate.observed)}`);
  return { verdict, failed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * The real runner: a headless `omp -p --mode json` on the `@task` role in a private temporary directory, asked to call
 * the native `upgrade_dependency` tool on the one pull request. It needs that tool installed where omp loads tools
 * from; without it the run ends with no call and the pull request is reported `needs_work`, not skipped. The upgrade
 * itself pushes to the pull request, labels it and spends model quota.
 */
export function ompUpgradeRunner(host: Host, options: { timeoutMs?: number } = {}): UpgradeRunner {
  return async (prUrl) => {
    const directory = await mkdtemp(join(tmpdir(), "green-default-branch-upgrade-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, upgradePrompt(prUrl), { mode: 0o600 });
      const ran = await host.exec(
        OMP_BIN,
        [
          "-p",
          `@${file}`,
          "--mode",
          "json",
          "--model",
          OMP_TASK_ROLE,
          "--no-session",
          "--no-title",
          "--no-skills",
          "--no-rules",
          "--no-context-files",
        ],
        { cwd: directory, timeoutMs: options.timeoutMs ?? UPGRADE_LIMIT_MS },
      );
      if (ran.timedOut === true) return { error: `omp did not finish ${UPGRADE_TOOL} in time` };
      const report = reportOfEvents(ran.stdout);
      if ("error" in report && ran.status !== 0) {
        return { error: `${report.error}; omp exited ${ran.status}: ${ran.stderr.trim().slice(0, 300)}` };
      }
      return report;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
