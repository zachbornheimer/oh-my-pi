import type { LinearPort, LinearTicket } from "./ticket.js";

/**
 * The Linear port, straight to Linear's GraphQL API (no MCP gateway, no Docker). The workspace is chosen by the
 * identifier's prefix, so a work ticket never reaches the personal workspace or back; the API key for a prefix is the
 * environment variable `LINEAR_API_KEY_<PREFIX>` (`LINEAR_API_KEY_ZYS`, `LINEAR_API_KEY_SAH`). An unknown prefix, or a
 * prefix whose variable is unset, is refused naming it; no other key is ever tried.
 */

/** The prefixes this port serves, one Linear workspace each. */
export const LINEAR_PREFIXES = ["ZYS", "SAH"] as const;
export const GRAPHQL_URL = "https://api.linear.app/graphql";
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;
/** Sub-issues read per ticket; a ticket with more is refused rather than silently cut short. */
const MAX_SUB_ISSUES = 50;
const REQUEST_DEADLINE_MS = 30_000;

/** The environment variable that holds the API key for an identifier's workspace; an unknown prefix is an error. */
export function linearKeyVariable(identifier: string): string {
  const prefix = IDENTIFIER.exec(identifier)?.[1]?.toUpperCase();
  if (prefix === undefined) throw new Error(`linear: not a Linear identifier (TEAM-123): ${identifier}`);
  if (!(LINEAR_PREFIXES as readonly string[]).includes(prefix)) {
    throw new Error(`linear: unknown prefix ${prefix} on ${identifier}; known: ${LINEAR_PREFIXES.join(", ")}`);
  }
  return `LINEAR_API_KEY_${prefix}`;
}

const ISSUE_QUERY = `query($id: String!, $first: Int!) {
  issue(id: $id) { id identifier title description children(first: $first) { nodes { identifier } pageInfo { hasNextPage } } }
}`;
const COMMENT_MUTATION = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;

export interface LinearOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

interface IssueData {
  issue?: {
    id?: unknown;
    identifier?: unknown;
    title?: unknown;
    description?: unknown;
    children?: { nodes?: { identifier?: unknown }[]; pageInfo?: { hasNextPage?: unknown } };
  } | null;
}

export function linearPort(options: LinearOptions = {}): LinearPort {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;

  async function post(identifier: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const variable = linearKeyVariable(identifier);
    const key = env[variable];
    if (key === undefined || key.trim() === "") {
      throw new Error(`linear: ${variable} is not set; it holds the API key for ${identifier}'s workspace`);
    }
    const token = key.trim();
    const response = await doFetch(GRAPHQL_URL, {
      method: "POST",
      // Personal API keys go in the header as-is; an OAuth access token takes the Bearer scheme.
      headers: { authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]) : AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    if (!response.ok) throw new Error(`linear ${identifier}: http ${response.status}`);
    const answer = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
    if (answer.errors !== undefined && answer.errors.length > 0) {
      throw new Error(`linear ${identifier}: ${answer.errors.map((error) => error.message ?? "error").join("; ")}`);
    }
    return answer.data;
  }

  async function read(identifier: string) {
    const issue = ((await post(identifier, ISSUE_QUERY, { id: identifier, first: MAX_SUB_ISSUES + 1 })) as IssueData | undefined)?.issue;
    if (issue === null || issue === undefined) throw new Error(`linear ${identifier}: no such issue`);
    if (typeof issue.id !== "string" || typeof issue.identifier !== "string" || typeof issue.title !== "string") {
      throw new Error(`linear ${identifier}: the answer carried no id, identifier and title`);
    }
    const nodes = issue.children?.nodes ?? [];
    if (issue.children?.pageInfo?.hasNextPage === true || nodes.length > MAX_SUB_ISSUES) {
      throw new Error(`linear: ${identifier} has more than ${MAX_SUB_ISSUES} sub-issues; split it first`);
    }
    const subIssues = nodes.map((node) => {
      if (typeof node.identifier !== "string") throw new Error(`linear ${identifier}: a sub-issue carried no identifier`);
      return node.identifier;
    });
    return {
      id: issue.id,
      ticket: {
        identifier: issue.identifier,
        title: issue.title,
        description: typeof issue.description === "string" ? issue.description : "",
        subIssues,
      } satisfies LinearTicket,
    };
  }

  return {
    async issue(identifier) {
      return (await read(identifier)).ticket;
    },
    async comment(identifier, body) {
      const { id } = await read(identifier);
      const created = (await post(identifier, COMMENT_MUTATION, { input: { issueId: id, body } })) as
        | { commentCreate?: { success?: unknown } }
        | undefined;
      if (created?.commentCreate?.success !== true) throw new Error(`linear ${identifier}: commentCreate did not succeed`);
    },
  };
}
