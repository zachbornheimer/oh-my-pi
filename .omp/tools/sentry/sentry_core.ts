/**
 * The Sentry REST port. One bearer token from the environment, one base URL, no state. Every failure throws: the
 * tool wrapper turns a throw into a failed tool result. API replies are narrowed here, so fields the tool does not
 * name never reach the caller's context.
 */

export const SENTRY_BASE_URL = "https://sentry.io/api/0";
export const DEFAULT_ORG = "software-automation-holdings-l";
export const DEFAULT_ISSUE_LIMIT = 20;
export const MAX_ISSUE_LIMIT = 100;
/** How long one HTTP call may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How much of an error body a failure message carries. */
const BODY_CHARS = 500;

export type SentryEnv = Readonly<Record<string, string | undefined>>;
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SentryInput {
  readonly action: "list_projects" | "create_project" | "list_keys" | "list_issues";
  readonly name?: string | null | undefined;
  readonly platform?: string | null | undefined;
  readonly project?: string | null | undefined;
  readonly query?: string | null | undefined;
  readonly limit?: number | null | undefined;
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
  platform: string | null;
  isMember: boolean;
  dateCreated: string;
}

export interface SentryKey {
  id: string;
  label: string;
  dsn: { public: string };
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  permalink: string;
  level: string;
  status: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: { slug: string; name: string };
}

export type SentryOutput =
  | { action: "list_projects"; org: string; projects: SentryProject[]; has_more: boolean }
  | { action: "create_project"; org: string; project: SentryProject; keys: SentryKey[] }
  | { action: "list_keys"; org: string; project: string; keys: SentryKey[] }
  | { action: "list_issues"; org: string; issues: SentryIssue[]; has_more: boolean };

export interface SentryDeps {
  readonly env?: SentryEnv | undefined;
  readonly fetch?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The org slug a call targets: SENTRY_ORG when set, else the SAH org. */
export function sentryOrg(env: SentryEnv): string {
  return env.SENTRY_ORG?.trim() || DEFAULT_ORG;
}

/** The paths each action hits, split out so tests can assert the call shape. Slugs are escaped into one segment. */
export const sentryPaths = {
  listProjects: (org: string) => `/organizations/${encodeURIComponent(org)}/projects/`,
  createProject: (org: string) => `/organizations/${encodeURIComponent(org)}/projects/`,
  listKeys: (org: string, project: string) => `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/keys/`,
  listIssues: (org: string, project: string | undefined, query: string | undefined, limit: number) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (project) params.set("project", project);
    // An empty query is meaningful: Sentry applies `is:unresolved` only when `query` is absent.
    if (query !== undefined) params.set("query", query);
    return `/organizations/${encodeURIComponent(org)}/issues/?${params}`;
  },
};

/** The reasons an input is refused, or an empty list. `null` reads as absent: models send it for an optional field. */
export function inputIssues(input: SentryInput): string[] {
  const issues: string[] = [];
  const has = (value: unknown): boolean => value !== undefined && value !== null && value !== "";
  if (!["list_projects", "create_project", "list_keys", "list_issues"].includes(input.action)) {
    return ["`action` must be one of list_projects, create_project, list_keys, list_issues"];
  }
  if (input.action === "create_project" && !has(input.name)) issues.push("create_project requires `name`");
  if ((input.action === "list_keys" || input.action === "list_issues") && !has(input.project)) {
    issues.push(`${input.action} requires \`project\``);
  }
  if (input.limit != null) {
    if (input.action !== "list_issues") issues.push("`limit` is read by `list_issues`");
    else if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ISSUE_LIMIT) {
      issues.push(`\`limit\` must be an integer from 1 to ${MAX_ISSUE_LIMIT}`);
    }
  }
  if (has(input.query) && input.action !== "list_issues") issues.push("`query` is read by `list_issues`");
  if (has(input.platform) && input.action !== "create_project") issues.push("`platform` is read by `create_project`");
  if (has(input.name) && input.action !== "create_project") issues.push("`name` is read by `create_project`");
  if (has(input.project) && input.action === "list_projects") issues.push("`project` is read by `list_keys` and `list_issues`");
  if (has(input.project) && input.action === "create_project") issues.push("`project` is read by `list_keys` and `list_issues`");
  return issues;
}

interface Reply {
  readonly body: unknown;
  readonly hasMore: boolean;
}

/** Sentry marks another page with `Link: <...>; rel="next"; results="true"`. */
function hasNextPage(link: string | null): boolean {
  return link !== null && /rel="next";\s*results="true"/.test(link);
}

/** A path stays under the API root: it starts with `/` and none of its segments is `.` or `..` (an escaped slug can still be `..`). */
function assertSentryApiPath(path: string): void {
  const segments = path.split("?")[0]!.split("/");
  if (!path.startsWith("/") || path.startsWith("//") || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`refusing Sentry path ${JSON.stringify(path)}: it must stay under the API root`);
  }
}

/** One Sentry REST call. Returns the parsed JSON, or throws `<path>: HTTP {status}: {body}` on a non-2xx. */
async function sentryRequest(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; token: string },
  deps: SentryDeps,
): Promise<Reply> {
  assertSentryApiPath(path);
  // The real call keeps a literal origin: only `path`, whose segments are escaped, varies.
  const send: Fetch = deps.fetch ?? ((url, options) => fetch(`https://sentry.io/api/0${url.slice(SENTRY_BASE_URL.length)}`, options));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  const bare = path.split("?")[0]!;
  let response: Response;
  let text: string;
  try {
    response = await send(`${SENTRY_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    if (timeout.aborted) throw new Error(`${bare}: no reply within ${timeoutMs / 1000} s`);
    throw new Error(`${bare}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hasMore = hasNextPage(response.headers.get("link"));
  if (!response.ok) {
    throw new Error(`${bare}: HTTP ${response.status}: ${text.replace(/\s+/g, " ").trim().slice(0, BODY_CHARS)}`);
  }
  if (text.trim() === "") return { body: {}, hasMore };
  try {
    return { body: JSON.parse(text), hasMore };
  } catch {
    throw new Error(`${bare}: the reply is not JSON (${text.replace(/\s+/g, " ").trim().slice(0, 120)})`);
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(body: unknown, what: string): Row[] {
  if (Array.isArray(body) && body.every(isRow)) return body;
  throw new Error(`${what}: expected a list of objects, read ${JSON.stringify(body)?.slice(0, 200) ?? "nothing"}`);
}

function text(row: Row, key: string): string {
  const value = row[key];
  return value === undefined || value === null ? "" : String(value);
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === undefined || value === null || value === "" ? null : String(value);
}

export function projectRow(row: Row): SentryProject {
  return {
    id: text(row, "id"),
    slug: text(row, "slug"),
    name: text(row, "name"),
    platform: textOrNull(row, "platform"),
    isMember: row.isMember === true,
    dateCreated: text(row, "dateCreated"),
  };
}

/** A key as the caller needs it: the public DSN. The secret half of a DSN is dropped, not forwarded. */
export function keyRow(row: Row): SentryKey {
  const dsn = isRow(row.dsn) ? row.dsn : {};
  return { id: text(row, "id"), label: text(row, "label"), dsn: { public: text(dsn, "public") } };
}

export function issueRow(row: Row): SentryIssue {
  const project = isRow(row.project) ? row.project : {};
  const users = Number(row.userCount);
  return {
    id: text(row, "id"),
    shortId: text(row, "shortId"),
    title: text(row, "title"),
    culprit: textOrNull(row, "culprit"),
    permalink: text(row, "permalink"),
    level: text(row, "level"),
    status: text(row, "status"),
    count: text(row, "count"),
    userCount: Number.isFinite(users) ? users : 0,
    firstSeen: text(row, "firstSeen"),
    lastSeen: text(row, "lastSeen"),
    project: { slug: text(project, "slug"), name: text(project, "name") },
  };
}

/** Make one Sentry call. Throws, with the reason as the message, when it cannot. */
export async function runSentry(input: SentryInput, deps: SentryDeps = {}): Promise<SentryOutput> {
  const issues = inputIssues(input);
  if (issues.length > 0) throw new Error(`invalid input for sentry: ${issues.join("; ")}`);
  const env = deps.env ?? process.env;
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  const org = sentryOrg(env);
  if (!token) {
    throw new Error(
      "SENTRY_AUTH_TOKEN is not set in the omp process environment; export a Sentry auth token "
        + "(org:read, project:read, project:write scopes) before starting omp.",
    );
  }

  switch (input.action) {
    case "list_projects": {
      const reply = await sentryRequest(sentryPaths.listProjects(org), { token }, deps);
      return {
        action: "list_projects",
        org,
        projects: rowsOf(reply.body, "the projects reply").map(projectRow),
        has_more: reply.hasMore,
      };
    }
    case "create_project": {
      const created = await sentryRequest(
        sentryPaths.createProject(org),
        {
          method: "POST",
          body: { name: input.name, ...(input.platform ? { platform: input.platform } : {}) },
          token,
        },
        deps,
      );
      if (!isRow(created.body) || text(created.body, "slug") === "") {
        throw new Error(
          `the create reply carries no project slug: ${JSON.stringify(created.body)?.slice(0, 200) ?? "nothing"}`,
        );
      }
      const project = projectRow(created.body);
      try {
        const keys = await sentryRequest(sentryPaths.listKeys(org, project.slug), { token }, deps);
        return { action: "create_project", org, project, keys: rowsOf(keys.body, "the keys reply").map(keyRow) };
      } catch (error) {
        // The project exists now; say so, or the caller retries and creates a duplicate.
        throw new Error(
          `project \`${project.slug}\` was created in ${org}, but reading its keys failed (use list_keys): `
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    case "list_keys": {
      const project = input.project!;
      const keys = await sentryRequest(sentryPaths.listKeys(org, project), { token }, deps);
      return { action: "list_keys", org, project, keys: rowsOf(keys.body, "the keys reply").map(keyRow) };
    }
    case "list_issues": {
      const reply = await sentryRequest(
        sentryPaths.listIssues(
          org,
          input.project ?? undefined,
          input.query ?? undefined,
          input.limit ?? DEFAULT_ISSUE_LIMIT,
        ),
        { token },
        deps,
      );
      return {
        action: "list_issues",
        org,
        issues: rowsOf(reply.body, "the issues reply").map(issueRow),
        has_more: reply.hasMore,
      };
    }
  }
}
