import { GH_BIN } from "./constants.js";
import type { Host } from "./host.js";
import type { Listing, ViewerPermission } from "./inclusion.js";
import type { JobFact, OpenFix, RollupState } from "./triage.js";

export type WorkflowFact = { status: number; count: number; names: string[] };
export type RollupFact = { status: number; rollup: RollupState; headSha: string; jobs: JobFact[] };
export type PullFact = { number: number; url: string; title: string; authorLogin: string; labels: string[] };

/** `gh pr list` stops at 30 by default; a repository with many open bot pull requests would hide the one it looks for. */
const PULL_LIST_LIMIT = "1000";

const ROLLUP_QUERY =
  `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid ... on Commit {statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name conclusion detailsUrl status checkSuite{workflowRun{databaseId workflow{name}}}} ... on StatusContext{context state targetUrl}}}}}}}}}`;

/**
 * Every repository the `gh` user can see: the user's own and collaborations plus each organisation's. A listing that
 * does not answer 200 throws; a half-read universe would turn missing repositories into a quiet success.
 */
export async function listUniverse(host: Host): Promise<{ login: string; orgs: string[]; repos: Listing[] }> {
  const user = await ghListing(host, ["api", "user"]);
  const login = textField(user, "login");
  const orgs = arrayOf(await ghListing(host, ["api", "--paginate", "user/orgs"]))
    .map((org) => textField(org, "login"))
    .filter((org) => org !== "");
  const repos: Listing[] = [];
  for (const org of orgs) {
    const page = await ghListing(host, ["api", "--paginate", `orgs/${org}/repos?per_page=100`]);
    repos.push(...arrayOf(page).map(listingOf));
  }
  const owned = await ghListing(host, ["api", "--paginate", "user/repos?affiliation=owner,collaborator&per_page=100"]);
  repos.push(...arrayOf(owned).map(listingOf));
  return { login, orgs, repos };
}

async function ghListing(host: Host, args: string[]): Promise<unknown> {
  const result = await ghJson(host, args);
  if (result.status !== 200) throw new Error(`gh ${args.join(" ")} answered HTTP ${result.status}`);
  return result.body;
}

/** One repository as the account lists it; undefined when `gh` cannot read it. */
export async function readListing(host: Host, repo: string): Promise<Listing | undefined> {
  const result = await ghJson(host, ["api", `repos/${repo}`]);
  if (result.status !== 200 || Object.keys(record(result.body)).length === 0) return undefined;
  return listingOf(result.body);
}

export async function readWorkflows(host: Host, repo: string): Promise<WorkflowFact> {
  const result = await ghJson(host, ["api", `repos/${repo}/actions/workflows`]);
  const workflows = arrayOf(recordField(result.body, "workflows"));
  return { status: result.status, count: workflows.length, names: workflows.map((item) => textField(item, "name")) };
}

export async function readRollup(host: Host, repo: string): Promise<RollupFact> {
  const [owner, name] = repo.split("/");
  const result = await ghJson(host, [
    "api",
    "graphql",
    "-f",
    `query=${ROLLUP_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);
  if (result.status !== 200) return { status: result.status, rollup: "ABSENT", headSha: "", jobs: [] };
  return parseRollup(result.body);
}

export async function readPreviousConclusion(
  host: Host,
  repo: string,
  branch: string,
  workflow: string,
): Promise<string | null> {
  const result = await ghJson(host, [
    "run",
    "list",
    "--repo",
    repo,
    "--branch",
    branch,
    "--workflow",
    workflow,
    "--limit",
    "2",
    "--json",
    "conclusion,name,createdAt",
  ]);
  const runs = arrayOf(result.body);
  const previous = runs[1];
  return previous === undefined ? null : textField(previous, "conclusion");
}

export async function readOpenFix(host: Host, repo: string): Promise<OpenFix | undefined> {
  const result = await ghJson(host, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    PULL_LIST_LIMIT,
    "--json",
    "number,url,headRefName,headRefOid",
  ]);
  const match = arrayOf(result.body).find((pr) => textField(pr, "headRefName").startsWith("ci-green/"));
  if (match === undefined) return undefined;
  return {
    number: numberField(match, "number"),
    url: textField(match, "url"),
    branch: textField(match, "headRefName"),
    headSha: textField(match, "headRefOid"),
  };
}

export async function readMerge(
  host: Host,
  repo: string,
  number: number,
): Promise<{ state: string; mergeStateStatus: string; mergeCommit: string; url: string }> {
  const result = await ghJson(host, [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "state,mergeStateStatus,mergeCommit,url",
  ]);
  const body = record(result.body);
  const merge = body.mergeCommit;
  const oid = merge && typeof merge === "object" ? textField(merge, "oid") : "";
  return {
    state: textField(body, "state"),
    mergeStateStatus: textField(body, "mergeStateStatus"),
    mergeCommit: oid,
    url: textField(body, "url"),
  };
}

/** Open pull requests with their author and labels, for the dependency bots' upgrade pull requests. */
export async function readPulls(host: Host, repo: string): Promise<PullFact[]> {
  const result = await ghJson(host, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    PULL_LIST_LIMIT,
    "--json",
    "number,url,title,author,labels",
  ]);
  if (result.status !== 200) throw new Error(`gh pr list for ${repo} answered HTTP ${result.status}`);
  return arrayOf(result.body).map((pr) => ({
    number: numberField(pr, "number"),
    url: textField(pr, "url"),
    title: textField(pr, "title"),
    authorLogin: textField(recordField(pr, "author"), "login"),
    labels: arrayOf(recordField(pr, "labels")).map((label) => textField(label, "name")),
  }));
}

function httpStatus(result: { status: number; stderr: string }): number {
  const match = result.stderr.match(/HTTP (\d{3})/);
  if (match?.[1] !== undefined) return Number(match[1]);
  return result.status === 0 ? 200 : result.status;
}

async function ghJson(host: Host, args: string[]): Promise<{ status: number; body: unknown }> {
  const result = await host.exec(GH_BIN, args);
  const status = httpStatus(result);
  if (result.stdout.trim() === "") return { status, body: status === 200 ? [] : null };
  try {
    return { status, body: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} returned unreadable JSON: ${(error as Error).message}`);
  }
}

function listingOf(value: unknown): Listing {
  const permissions = recordField(value, "permissions");
  return {
    nameWithOwner: textField(value, "full_name"),
    archived: booleanField(value, "archived"),
    fork: booleanField(value, "fork"),
    viewerPermission: permissionOf(permissions),
    defaultBranch: textField(value, "default_branch") || "main",
  };
}

function permissionOf(permissions: unknown): ViewerPermission {
  if (booleanField(permissions, "admin")) return "ADMIN";
  if (booleanField(permissions, "maintain")) return "MAINTAIN";
  if (booleanField(permissions, "push")) return "WRITE";
  if (booleanField(permissions, "triage")) return "TRIAGE";
  if (permissions && typeof permissions === "object") return "READ";
  return "NONE";
}

function parseRollup(body: unknown): RollupFact {
  const target = dig(body, ["data", "repository", "defaultBranchRef", "target"]);
  const rollup = recordField(target, "statusCheckRollup");
  const headSha = textField(target, "oid");
  if (!rollup || Object.keys(record(rollup)).length === 0) {
    return { status: 200, rollup: "ABSENT", headSha, jobs: [] };
  }
  const state = textField(rollup, "state").toUpperCase();
  const nodes = arrayOf(recordField(recordField(rollup, "contexts"), "nodes"));
  return { status: 200, rollup: asRollup(state), headSha, jobs: nodes.map(jobOf).filter((job) => job.name !== "") };
}

function jobOf(node: unknown): JobFact {
  const typeName = textField(node, "__typename");
  const actionsRun = typeName === "CheckRun";
  const workflowRun = recordField(recordField(node, "checkSuite"), "workflowRun");
  const workflow = recordField(workflowRun, "workflow");
  return {
    name: actionsRun ? textField(node, "name") : textField(node, "context"),
    conclusion: (textField(node, "conclusion") || textField(node, "state")).toUpperCase(),
    logUrl: textField(node, "detailsUrl") || textField(node, "targetUrl"),
    actionsRun,
    workflowName: textField(workflow, "name") || textField(node, "name"),
    runId: numberField(workflowRun, "databaseId") || null,
    previousConclusion: null,
  };
}

function asRollup(state: string): RollupState {
  if (state === "SUCCESS" || state === "FAILURE" || state === "ERROR" || state === "PENDING" || state === "EXPECTED") {
    return state;
  }
  return "ABSENT";
}

function dig(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => recordField(current, key), value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordField(value: unknown, key: string): unknown {
  return record(value)[key];
}

function textField(value: unknown, key: string): string {
  const field = recordField(value, key);
  return typeof field === "string" ? field : "";
}

function booleanField(value: unknown, key: string): boolean {
  return recordField(value, key) === true;
}

function numberField(value: unknown, key: string): number {
  const field = recordField(value, key);
  return typeof field === "number" ? field : 0;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
