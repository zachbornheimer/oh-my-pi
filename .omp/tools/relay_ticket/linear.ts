import { readFile } from "node:fs/promises";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { LinearPort, LinearTicket } from "./types.js";

/** A Linear personal API key (or OAuth token); one key reads one workspace, so a ZYS and an SAH ticket need their own keys. */
export const LINEAR_KEY_ENV = "LINEAR_API_KEY";
/** A file holding the Relay app's OAuth pair as JSON `{ "access_token": "…" }`: a receiver writes and refreshes it, this port only reads it. */
export const RELAY_APP_FILE_ENV = "RELAY_LINEAR_TOKEN_FILE";

const GRAPHQL_URL = "https://api.linear.app/graphql";
/** Sub-issues read per ticket; a ticket with more is refused rather than silently cut short. */
const MAX_SUB_ISSUES = 50;
/** An app token refreshed by its receiver on the next poll after a 401: one retry after this wait reads the refreshed file. */
const REFRESH_WAIT_MS = 20_000;
const REQUEST_DEADLINE_MS = 30_000;

const ISSUE_QUERY = `query($id: String!, $first: Int!) {
  issue(id: $id) { id identifier title description children(first: $first) { nodes { identifier } pageInfo { hasNextPage } } }
}`;
const COMMENT_MUTATION = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;

/** How a request authenticates: the Authorization header value, read per call. */
export type AuthSource = () => Promise<string>;

export interface LinearOptions {
  readonly auth: AuthSource;
  /** Whether a 401 is retried once after `refreshWaitMs`: true for a token file a receiver refreshes. */
  readonly refreshes?: boolean;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly refreshWaitMs?: number;
  readonly signal?: AbortSignal;
}

class Unauthorized extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Chooses the credential: the app token file when named, else `LINEAR_API_KEY`; neither is an error, never a silent default. */
export function authFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): { auth: AuthSource; refreshes: boolean } {
  const file = env[RELAY_APP_FILE_ENV];
  if (file !== undefined && file !== "") {
    return {
      refreshes: true,
      async auth() {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        const token = isRecord(parsed) ? parsed.access_token : undefined;
        if (typeof token !== "string" || token === "") throw new Error(`linear: ${file} has no access_token`);
        return `Bearer ${token}`;
      },
    };
  }
  const key = env[LINEAR_KEY_ENV];
  if (key === undefined || key.trim() === "") {
    throw new Error(`linear: set ${LINEAR_KEY_ENV} (a Linear API key) or ${RELAY_APP_FILE_ENV} (an app token file)`);
  }
  const value = key.trim();
  // A personal API key goes in the header as is; an OAuth access token takes the Bearer scheme.
  const header = value.startsWith("lin_oauth_") ? `Bearer ${value}` : value;
  return { refreshes: false, auth: async () => header };
}

/** The Linear port over GraphQL: read one issue with its sub-issue identifiers, post one comment. */
export function linearPort(options: LinearOptions): LinearPort {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
  const refreshWaitMs = options.refreshWaitMs ?? REFRESH_WAIT_MS;

  async function post(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const signals = [AbortSignal.timeout(REQUEST_DEADLINE_MS), ...(options.signal === undefined ? [] : [options.signal])];
    const response = await doFetch(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: await options.auth(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.any(signals),
    });
    if (response.status === 401) throw new Unauthorized("linear: the access token was refused (401)");
    if (!response.ok) throw new Error(`linear: http ${response.status}`);
    const answer: unknown = await response.json();
    if (!isRecord(answer)) throw new Error("linear: the answer is not a JSON object");
    const errors = Array.isArray(answer.errors) ? answer.errors.map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : "unknown error")) : [];
    if (errors.length > 0) {
      if (errors.some((text) => /not authenticated|authentication/i.test(text))) throw new Unauthorized(`linear: ${errors[0]}`);
      throw new Error(`linear: ${errors.join("; ")}`);
    }
    return answer.data;
  }

  async function ask(query: string, variables: Record<string, unknown>): Promise<unknown> {
    try {
      return await post(query, variables);
    } catch (error) {
      if (!(error instanceof Unauthorized) || options.refreshes !== true) throw error;
      await sleep(refreshWaitMs);
      return post(query, variables);
    }
  }

  async function read(identifier: string) {
    const data = await ask(ISSUE_QUERY, { id: identifier, first: MAX_SUB_ISSUES + 1 });
    const issue = isRecord(data) ? data.issue : undefined;
    if (!isRecord(issue)) throw new Error(`linear: ${identifier} was not found`);
    const { id, title, children } = issue;
    const nodes = isRecord(children) && Array.isArray(children.nodes) ? children.nodes : undefined;
    const hasNextPage = isRecord(children) && isRecord(children.pageInfo) ? children.pageInfo.hasNextPage : undefined;
    if (typeof id !== "string" || typeof issue.identifier !== "string" || typeof title !== "string" || nodes === undefined || typeof hasNextPage !== "boolean") {
      throw new Error(`linear: ${identifier} came back in an unreadable shape`);
    }
    return {
      id,
      identifier: issue.identifier,
      title,
      description: typeof issue.description === "string" ? issue.description : "",
      children: nodes.map((node) => (isRecord(node) && typeof node.identifier === "string" ? node.identifier : "")),
      hasNextPage,
    };
  }

  return {
    async issue(identifier): Promise<LinearTicket> {
      const issue = await read(identifier);
      if (issue.hasNextPage || issue.children.length > MAX_SUB_ISSUES) {
        throw new Error(`linear: ${identifier} has more than ${MAX_SUB_ISSUES} sub-issues; split it first`);
      }
      return { identifier: issue.identifier, title: issue.title, description: issue.description, subIssues: issue.children };
    },
    async comment(identifier, body) {
      const { id } = await read(identifier);
      const data = await ask(COMMENT_MUTATION, { input: { issueId: id, body } });
      const created = isRecord(data) && isRecord(data.commentCreate) ? data.commentCreate.success : undefined;
      if (created !== true) throw new Error(`linear: commentCreate on ${identifier} did not succeed`);
    },
  };
}
