import { askObject, type Exec, NO_RECURSION } from "./omp_session.js";
import { type Obj, reqArray, reqBool, reqObject, reqString } from "./shape.js";
import { type Workspace, WORKSPACES, workspaceOfTeam } from "./workspaces.js";

export const LIST_ELIGIBLE_TICKETS_NAME = "list_eligible_tickets";

/** The factory's default: one ticket at a time. */
export const SWEEP_DEFAULT_LIMIT = 1;
/** Linear's priority 0 is "No priority". */
export const NO_PRIORITY = 0;
/** One session lists one workspace, paging through every ticket in its input statuses. */
export const LIST_TIMEOUT_MS = 10 * 60_000;

export interface IssueSummary {
  identifier: string;
  status: string;
  /** Linear's number: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  /** ISO 8601. */
  createdAt: string;
}

/** What a host provides: every issue of the workspace's team now in one of `statuses`, or only those in `project` when one is named. */
export interface EligiblePorts {
  listIssues(workspace: Workspace, statuses: readonly string[], project?: string): Promise<IssueSummary[]>;
}

/** Urgent (1) before Low (4); "No priority" (0) after every real priority. */
function priorityRank(priority: number): number {
  return priority === NO_PRIORITY ? Number.POSITIVE_INFINITY : priority;
}

/** The one upstream answer that means "this workspace simply has no such project", not a failure. */
const UNKNOWN_PROJECT = /could not find project/i;

/** Priority first, then the oldest ticket. Ties on both keep the order they came in (workspace order, then Linear's). */
export function inWorkOrder(issues: readonly IssueSummary[]): IssueSummary[] {
  return [...issues].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/**
 * Read-only: the next tickets to work, from each workspace's own input statuses (every configured workspace unless
 * `teams` names some, and only `project` when one is named), highest priority first and oldest first within a priority,
 * at most `limit` of them (default 1). The tickets may come from different workspaces: they are ordered together, and
 * worked one at a time. A named project is one Linear project, and only some workspaces have it (a sweep of "AI Tooling"
 * reaches the ZYS workspace and no other), so a workspace whose Linear cannot resolve it contributes no tickets instead of
 * failing the whole sweep. Any other failure still propagates.
 */
export async function listEligibleTickets(
  ports: EligiblePorts,
  input: { teams?: readonly string[]; project?: string; limit?: number },
): Promise<string[]> {
  const limit = input.limit ?? SWEEP_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer, not ${String(input.limit)}`);
  const workspaces = (input.teams ?? WORKSPACES.map((workspace) => workspace.team)).map(workspaceOfTeam);
  const perWorkspace = await Promise.all(
    workspaces.map(async (workspace) => {
      try {
        return await ports.listIssues(workspace, workspace.inputs, input.project);
      } catch (error) {
        // Any other failure is a real one and propagates.
        if (input.project !== undefined && error instanceof Error && UNKNOWN_PROJECT.test(error.message)) return [];
        throw error;
      }
    }),
  );
  const unique = new Map<string, IssueSummary>();
  for (const issue of perWorkspace.flat()) unique.set(issue.identifier, issue);
  return inWorkOrder([...unique.values()])
    .slice(0, limit)
    .map((issue) => issue.identifier);
}

/** The listing prompt: read-only, every page, one JSON object. */
export function listingPrompt(workspace: Workspace, statuses: readonly string[], project: string | undefined): string {
  const quoted = statuses.map((status) => `"${status}"`).join(", ");
  return `List the Linear issues of team ${workspace.team} (the workspace served by the Linear MCP server "${workspace.server}", or whichever Linear tool reaches the team whose key is ${workspace.team}) that are right now in one of exactly these statuses: ${quoted}.${
    project === undefined
      ? ""
      : ` Only issues in the Linear project named "${project}" count. When the workspace has no project with that name, reply {"project_found":false,"complete":true,"issues":[]}.`
  }

This is a read-only check: change nothing. Linear tools are not preloaded: find them with tool_search. Page through every result until none is left; never stop at a first page or cap the count. Open nothing else.

For each issue report: identifier (such as ${workspace.team}-123), status (its exact current status name), priority (Linear's number: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low), createdAt (ISO 8601, as Linear gives it).

${NO_RECURSION}

## Your answer

Reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"project_found": <false only when a project was named and the workspace has none>, "complete": <true only when you read every page>, "issues": [{"identifier": "${workspace.team}-123", "status": "${statuses[0]}", "priority": 2, "createdAt": "2026-10-01T09:30:00.000Z"}]}
issues is [] when there are none.`;
}

/**
 * What the session answers, checked in code: it must say it read every page; each issue must carry this team's key, one
 * of the input statuses, a priority 0-4 and a date. One that does not is a bad answer (asked again), never silently kept.
 */
export function listingOf(workspace: Workspace, statuses: readonly string[], value: Obj): { project_found: boolean; issues: IssueSummary[] } {
  if (!reqBool(value, "complete")) throw new Error("complete is false: read every page and answer again");
  const project_found = reqBool(value, "project_found");
  const pattern = new RegExp(`^${workspace.team}-\\d+$`);
  const issues = reqArray(value, "issues").map((entry, index): IssueSummary => {
    const issue = reqObject(entry, `issues[${index}]`);
    const identifier = reqString(issue, "identifier").trim().toUpperCase();
    if (!pattern.test(identifier)) throw new Error(`issues[${index}].identifier "${identifier}" is not a ${workspace.team} ticket`);
    const status = reqString(issue, "status");
    if (!statuses.includes(status)) {
      throw new Error(`issues[${index}] (${identifier}) is in "${status}", which is not one of ${statuses.join(", ")}`);
    }
    const priority = issue.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new Error(`issues[${index}] (${identifier}).priority must be an integer 0-4`);
    }
    const createdAt = reqString(issue, "createdAt");
    if (Number.isNaN(Date.parse(createdAt))) throw new Error(`issues[${index}] (${identifier}).createdAt "${createdAt}" is not a date`);
    return { identifier, status, priority, createdAt };
  });
  if (!project_found && issues.length > 0) throw new Error("project_found is false but issues are listed");
  return { project_found, issues };
}

export interface LiveDeps {
  exec: Exec;
  signal?: AbortSignal;
  cwd?: string;
}

/** The live port: one read-only full omp session per workspace. A named project the workspace does not have lists nothing. */
export function liveEligiblePorts(deps: LiveDeps): EligiblePorts {
  return {
    async listIssues(workspace, statuses, project) {
      if (statuses.length === 0) return [];
      const { issues } = await askObject(
        deps.exec,
        listingPrompt(workspace, statuses, project),
        (value) => listingOf(workspace, statuses, value),
        { timeoutMs: LIST_TIMEOUT_MS, signal: deps.signal, cwd: deps.cwd, label: `list_eligible_tickets ${workspace.team}` },
      );
      return issues;
    },
  };
}
