import type { HostMachine } from "./host_machine.js";
import type { ChangedFile, PullRequest, PullRequests, Ref } from "./load.js";
import type { CICheck } from "./schemas.js";

// Go internal/depupgrade/github.go: the PullRequests port over the host's gh. (Mastra preferred ghx and fell back to
// gh; this tool uses gh only.)

const GH_BIN = "gh";
/** The conclusions (or states) GitHub reports for a check that did not fail the pull request. */
const PASSED_STATES = new Set(["SUCCESS", "SUCCESSFUL", "SKIPPED", "NEUTRAL"]);
const PR_VIEW_FIELDS = "title,body,url,statusCheckRollup";

interface CheckRollup {
  readonly name?: unknown;
  readonly context?: unknown;
  readonly conclusion?: unknown;
  readonly state?: unknown;
}

/** github.go checkPassed: a check passes on its conclusion, else its state. */
function checkPassed(conclusion: string, state: string): boolean {
  return PASSED_STATES.has((conclusion === "" ? state : conclusion).toUpperCase());
}

/** github.go parseChecks: a check's name (else its context), or nothing when it reports neither. */
function parseChecks(raw: unknown): CICheck[] {
  if (raw === null || raw === undefined || !Array.isArray(raw)) return [];
  const checks: CICheck[] = [];
  for (const item of raw as CheckRollup[]) {
    const name = textOf(item.name) || textOf(item.context);
    if (name === "") continue;
    checks.push({ name, passed: checkPassed(textOf(item.conclusion), textOf(item.state)) });
  }
  return checks;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The pages `gh api --paginate` prints: one JSON array, or several concatenated. */
function arraysIn(text: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "[") {
      if (depth === 0) start = index;
      depth++;
    } else if (character === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return chunks;
}

/** The changed files in `gh api --paginate` output for a pull request's files. */
export function parsePullFiles(output: string): ChangedFile[] {
  return changedFilesOf(output);
}

function changedFilesOf(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const page of arraysIn(output)) {
    let decoded: { filename?: unknown; patch?: unknown }[];
    try {
      decoded = JSON.parse(page) as { filename?: unknown; patch?: unknown }[];
    } catch (error) {
      throw new Error(`github: decode pull files: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of decoded) {
      const path = textOf(entry.filename);
      if (path !== "") files.push({ path, patch: textOf(entry.patch) });
    }
  }
  return files;
}

/** The files of a pull request, reduced to what the snapshot keeps so large payloads stay small. */
const FILES_JQ = "[.[] | {filename: .filename, patch: .patch}]";

/** Reads a GitHub pull request through gh on the host machine. */
export class GitHub implements PullRequests {
  constructor(private readonly machine: HostMachine) {}

  async view(ref: Ref): Promise<PullRequest> {
    const output = await this.run(
      "pr",
      "view",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--json",
      PR_VIEW_FIELDS,
    );
    let decoded: { url?: unknown; title?: unknown; body?: unknown; statusCheckRollup?: unknown };
    try {
      decoded = JSON.parse(output) as typeof decoded;
    } catch (error) {
      throw new Error(`github: decode pr view: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      url: textOf(decoded.url),
      title: textOf(decoded.title),
      body: textOf(decoded.body),
      checks: parseChecks(decoded.statusCheckRollup),
    };
  }

  async files(ref: Ref): Promise<ChangedFile[]> {
    const output = await this.run(
      "api",
      `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`,
      "--paginate",
      "--jq",
      FILES_JQ,
    );
    return changedFilesOf(output);
  }

  private async run(...args: string[]): Promise<string> {
    const result = await this.machine.run(GH_BIN, args);
    if (result.code !== 0) {
      const detail = result.stderr.trim() === "" ? result.stdout.trim() : result.stderr.trim();
      throw new Error(`github: ${GH_BIN} ${args.join(" ")}: exit ${result.code}: ${detail}`);
    }
    return result.stdout;
  }
}
