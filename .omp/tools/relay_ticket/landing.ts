import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";

/** The tool that lands a pull request: a dependency bot's bump goes through `upgrade_dependency`, any other change through `make_pr_mergable`. */
export const LANDING_ROUTES = ["upgrade_dependency", "make_pr_mergable"] as const;
export type LandingRoute = (typeof LANDING_ROUTES)[number];

/**
 * `merged` and `queued` (a merge queue, or automerge, holds it open and merges it) are landed; every other state is the
 * landing tool's own word for why the pull request is still open, or `error` when it could not answer.
 */
export const LANDED_STATES: readonly string[] = ["merged", "queued"];

export interface Landing {
  readonly url: string;
  readonly route: LandingRoute;
  readonly state: string;
  readonly landed: boolean;
  readonly reasons: readonly string[];
}

export interface MergeReport {
  readonly status: string;
  readonly reasons: readonly string[];
}
/** `ready` means the upgrade loop ended done and the pull request is armed for automerge. */
export interface UpgradeReport {
  readonly verdict: "ready" | "needs_work" | "skipped";
  readonly reasons: readonly string[];
}

export interface LandingPorts {
  /** The login of the pull request's author, as GitHub names it (`app/renovate`, `dependabot[bot]`, `octocat`). */
  readPullRequestAuthor(url: string): Promise<string>;
  makePrMergable(input: { prUrl: string; merge: boolean }): Promise<MergeReport>;
  upgradeDependency(input: { prUrl: string }): Promise<UpgradeReport>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const DEPENDENCY_BOTS = ["dependabot", "renovate"] as const;

/** True for Dependabot and Renovate, including `app/` and `[bot]` login forms. */
export function isDependencyBotLogin(login: string): boolean {
  const author = login.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
  return DEPENDENCY_BOTS.some((bot) => author === bot || author.endsWith(`-${bot}`) || author.endsWith(`-${bot}-bot`));
}

/** The route a pull request's author picks: a dependency bot's pull request is upgraded, never put through the merge path. */
export function routeFor(authorLogin: string): LandingRoute {
  return isDependencyBotLogin(authorLogin) ? "upgrade_dependency" : "make_pr_mergable";
}

/**
 * Lands one pull request through the tool its author's kind names and answers where it stands. An `upgrade_dependency`
 * `ready` is `queued`: that tool arms automerge and never merges itself. Nothing here throws: a tool that cannot
 * answer is `error`, not landed, with its message as the reason.
 */
export async function landPullRequest(ports: LandingPorts, url: string, options: { merge: boolean }): Promise<Landing> {
  let route: LandingRoute = "make_pr_mergable";
  try {
    // Without the caller's opt-in nothing merges: the pull request is only driven to settled approved, reported not landed.
    if (!options.merge) {
      const report = await ports.makePrMergable({ prUrl: url, merge: false });
      return { url, route, state: report.status, landed: false, reasons: report.reasons };
    }
    route = routeFor(await ports.readPullRequestAuthor(url));
    if (route === "upgrade_dependency") {
      const report = await ports.upgradeDependency({ prUrl: url });
      const state = report.verdict === "ready" ? "queued" : report.verdict;
      return { url, route, state, landed: LANDED_STATES.includes(state), reasons: report.reasons };
    }
    const report = await ports.makePrMergable({ prUrl: url, merge: true });
    return { url, route, state: report.status, landed: LANDED_STATES.includes(report.status), reasons: report.reasons };
  } catch (error) {
    return { url, route, state: "error", landed: false, reasons: [message(error)] };
  }
}

/** One line a ticket comment or a settling report carries for a landing. */
export function landingLine(landing: Landing): string {
  return landing.landed
    ? `pull request ${landing.url} landed (${landing.state}, via ${landing.route})`
    : `pull request ${landing.url} NOT landed: ${landing.state} (via ${landing.route}); the ticket is not done`;
}

export const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** Parses the one JSON object an agent reply is (bare or as the one fenced block); anything else throws. */
export function parseReplyObject(reply: string): Record<string, unknown> {
  const text = reply.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced ? fenced[1]! : text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`the landing session's reply is not JSON (${message(error)}): ${body.slice(0, 160)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the landing session's reply is not a JSON object");
  return value as Record<string, unknown>;
}

function reasonsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error("the landing session's reasons are not a list of strings");
  return value;
}

export function readMergeReport(reply: string): MergeReport {
  const object = parseReplyObject(reply);
  if (typeof object.status !== "string" || object.status === "") throw new Error("the landing session's reply has no status");
  return { status: object.status, reasons: reasonsOf(object.reasons) };
}

export function readUpgradeReport(reply: string): UpgradeReport {
  const object = parseReplyObject(reply);
  if (object.verdict !== "ready" && object.verdict !== "needs_work" && object.verdict !== "skipped") {
    throw new Error("the landing session's reply has no verdict of ready, needs_work or skipped");
  }
  return { verdict: object.verdict, reasons: reasonsOf(object.reasons) };
}

const MAKE_DEADLINE_MS = 7 * 60 * 60_000;
const UPGRADE_DEADLINE_MS = 2 * 60 * 60_000;
const GH_DEADLINE_MS = 60_000;

/** The prompt that has a full omp session call one landing tool and answer with its result as JSON. */
function landingPrompt(tool: string, args: Record<string, unknown>, shape: string): string {
  return [
    `Call the omp tool named \`${tool}\` exactly once with this input: ${JSON.stringify(args)}.`,
    "Do not call `tool_call` or any `capability/*` tool, change nothing else, and do not retry a failed call.",
    `When it returns, answer with ONLY one JSON object ${shape}, copied from its result, and no other text.`,
    `If the \`${tool}\` tool is not available or it errors, answer with ONLY {"error":"<why>"}.`,
  ].join("\n");
}

/**
 * The live ports: GitHub's author through `gh`, and each landing tool through one full `omp -p` session (every tool and
 * extension on, so the sibling omp tool is there) that is told to call it and answer with its result as JSON. The reply
 * is validated in code; a malformed reply or an `error` reply is an error landing, never a guessed state.
 */
export function liveLandingPorts(exec: Exec, signal?: AbortSignal): LandingPorts {
  async function agent(prompt: string, timeoutMs: number): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "relay-landing-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const result = await exec("omp", ["-p", `@${file}`], { cwd: directory, timeoutMs, signal });
      if (result.stopped) throw new Error("the landing session was stopped at its deadline or by an abort");
      if (result.code !== 0) throw new Error(`the landing session exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-400)}`);
      const reply = result.stdout.trim();
      const object = parseReplyObject(reply);
      if (typeof object.error === "string") throw new Error(`the landing tool answered an error: ${object.error}`);
      return reply;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const checked = (url: string) => {
    if (!PULL_URL.test(url)) throw new Error(`not a pull request URL: ${url}`);
    return url;
  };
  return {
    async readPullRequestAuthor(url) {
      const result = await exec("gh", ["pr", "view", checked(url), "--json", "author"], { timeoutMs: GH_DEADLINE_MS, signal });
      if (result.code !== 0) throw new Error(`gh pr view exited ${result.code}: ${result.stderr.trim().slice(-400)}`);
      const view = JSON.parse(result.stdout) as { author?: { login?: unknown } | null };
      return typeof view.author?.login === "string" ? view.author.login : "";
    },
    async makePrMergable({ prUrl, merge }) {
      const args = { prUrl: checked(prUrl), target: "approved", merge, dryRun: false };
      return readMergeReport(await agent(landingPrompt("make_pr_mergable", args, `{"status":"<its status>","reasons":["<each reason>"]}`), MAKE_DEADLINE_MS));
    },
    async upgradeDependency({ prUrl }) {
      const args = { prUrl: checked(prUrl) };
      return readUpgradeReport(await agent(landingPrompt("upgrade_dependency", args, `{"verdict":"ready|needs_work|skipped","reasons":["<each failed gate as name: observed>"]}`), UPGRADE_DEADLINE_MS));
    },
  };
}
