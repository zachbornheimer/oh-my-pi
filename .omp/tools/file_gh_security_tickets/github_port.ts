import { MAX_ALERTS_PER_SOURCE } from "./constants.js";
import { AlertGoneError, AlertsUnavailableError, type RepositoryListing, type SecurityGhPort } from "./ports.js";
import { alertListArgs, alertReadArgs, repoListArgs } from "./sources.js";

export type GhRunResult = { exitCode: number; stdout: string; stderr: string };
export type GhRun = (args: readonly string[]) => Promise<GhRunResult>;

/** The shape of `pi.exec`, as far as this port uses it. */
export type PiExec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

const GH_TIMEOUT_MS = 5 * 60_000;

/** The real `gh` through `pi.exec`: one subprocess per call, its exit code and both streams answered. */
export function ghRunner(exec: PiExec, options: { cwd: string; signal?: AbortSignal }): GhRun {
  return async (args) => {
    let ran;
    try {
      ran = await exec("gh", [...args], { signal: options.signal, cwd: options.cwd, timeout: GH_TIMEOUT_MS });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(`gh could not run (is it installed?): ${(error as Error).message}`);
    }
    if (ran.killed) {
      options.signal?.throwIfAborted();
      throw new Error(`gh ${args.slice(0, 2).join(" ")} was stopped after ${GH_TIMEOUT_MS / 1000} s`);
    }
    return { exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr };
  };
}

/** `gh api` answers 403 and 404 with the same exit code; the message is what tells them from an operational fault. */
const NOT_ANSWERED = /HTTP 40[34]|Not Found/i;
const GONE = /HTTP 404|Not Found/i;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/**
 * `gh api --paginate` prints one JSON document per page back to back, so the pages are split by JSON depth rather than
 * by lines: a string inside an alert can carry a newline of its own.
 */
export function jsonDocuments(stdout: string): unknown[] {
  const documents: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let at = 0; at < stdout.length; at += 1) {
    const char = stdout[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        documents.push(JSON.parse(stdout.slice(start, at + 1)));
        start = -1;
      }
    }
  }
  return documents;
}

function parseListing(stdout: string): RepositoryListing[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("gh repo list answered something other than an array");
  return parsed.map((entry, index) => {
    const repository = entry as Record<string, unknown> | null;
    if (
      typeof repository !== "object" || repository === null || typeof repository.name !== "string"
      || typeof repository.isArchived !== "boolean" || typeof repository.isFork !== "boolean"
    ) {
      throw new Error(`gh repo list entry ${index} lacks name, isArchived or isFork`);
    }
    return { name: repository.name, isArchived: repository.isArchived, isFork: repository.isFork };
  });
}

/**
 * The real GitHub through `gh`: `--paginate` walks the `Link: rel="next"` chain to the end, a 403 or 404 for one
 * repository's source is answered as a skip, and any other failure names the repository and the stderr.
 */
export function ghSecurityPort(gh: GhRun): SecurityGhPort {
  return {
    async listRepos(owner) {
      const run = await gh(repoListArgs(owner));
      if (run.exitCode !== 0) {
        throw new Error(`gh repo list ${owner} failed (exit ${run.exitCode}): ${firstLine(run.stderr)}`);
      }
      return parseListing(run.stdout);
    },
    async listAlerts(input) {
      const repository = `${input.owner}/${input.repo}`;
      const run = await gh(alertListArgs(input));
      if (run.exitCode !== 0) {
        const reason = firstLine(run.stderr);
        if (NOT_ANSWERED.test(reason)) throw new AlertsUnavailableError(repository, reason);
        throw new Error(`gh api for ${repository} ${input.source} alerts failed (exit ${run.exitCode}): ${reason}`);
      }
      const alerts = jsonDocuments(run.stdout).flatMap((document) => (Array.isArray(document) ? document : [document]));
      if (alerts.length > MAX_ALERTS_PER_SOURCE) {
        throw new Error(
          `${repository} ${input.source} has more than ${MAX_ALERTS_PER_SOURCE} open alerts; narrow the target`,
        );
      }
      return alerts;
    },
    async readAlert(input) {
      const repository = `${input.owner}/${input.repo}`;
      const run = await gh(alertReadArgs(input));
      if (run.exitCode === 0) return JSON.parse(run.stdout) as unknown;
      const reason = firstLine(run.stderr);
      if (GONE.test(reason)) throw new AlertGoneError(repository);
      if (NOT_ANSWERED.test(reason)) throw new AlertsUnavailableError(repository, reason);
      throw new Error(`gh api for ${repository} ${input.source} alert ${input.number} failed (exit ${run.exitCode}): ${reason}`);
    },
  };
}
