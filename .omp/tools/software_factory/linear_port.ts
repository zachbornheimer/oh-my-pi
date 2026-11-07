import { execFile } from "node:child_process";
import { LINEAR_PAGE_SIZE, LINEAR_REQUEST_BUDGET_MS, MAX_LINEAR_PAGES } from "./constants.js";
import type { LinearPort } from "./ports.js";
import { type Comment, type Issue, type IssueSummary } from "./schemas.js";
import type { Workspace } from "./workspaces.js";

const ENDPOINT = "https://api.linear.app/graphql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Comments are read whole, page by page; a ticket with more than this many pages of them is a runaway. */
const MAX_COMMENT_PAGES = 20;
const COMMENT_PAGE_SIZE = 100;

/** The shape of `fetch` this port needs, so a test supplies its own. */
export type LinearFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type LinearPortOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: LinearFetch;
  keychain?: KeychainRead;
  /** Stops every request when the tool call is cancelled. */
  signal?: AbortSignal;
};

/** Reads one macOS Keychain generic password; answers undefined when there is no such item. Injected by tests. */
export type KeychainRead = (service: string, account: string) => Promise<string | undefined>;

/** The Keychain item the key of a workspace may live in: the one the capability gateway kept SAH's Linear token in. */
export function keychainAccountOf(workspace: Workspace): { service: string; account: string } {
  return { service: "capability-gateway", account: `linear.${workspace.team.toLowerCase()}_access_token` };
}

/** The real `security find-generic-password`; an absent item, or a machine without `security`, reads as undefined. */
export const readKeychain: KeychainRead = async (service, account) => {
  if (process.platform !== "darwin") return undefined;
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  execFile("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 10_000 }, (error, stdout) => {
    resolve(error === null && stdout.trim() !== "" ? stdout.trim() : undefined);
  });
  return promise;
};

/**
 * The key the workspace's requests are made with: its own variable (`LINEAR_API_KEY_<TEAM>`), else the shared
 * `LINEAR_API_KEY`, else the workspace's Keychain item. Read at call time, never kept in a log or an error.
 */
export async function linearKey(
  workspace: Workspace,
  env: Readonly<Record<string, string | undefined>>,
  keychain: KeychainRead = readKeychain,
): Promise<string> {
  const fromEnv = env[workspace.apiKeyEnv]?.trim() || env.LINEAR_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const item = keychainAccountOf(workspace);
  const fromKeychain = await keychain(item.service, item.account);
  if (fromKeychain !== undefined && fromKeychain !== "") return fromKeychain;
  throw new Error(
    `no Linear key for the ${workspace.team} workspace: set ${workspace.apiKeyEnv} (or LINEAR_API_KEY) in the omp process environment, `
    + `or store it in the Keychain as service ${item.service}, account ${item.account}`,
  );
}

/** A personal API key goes as is; an OAuth token (`lin_oauth_…`) or an explicit `Bearer …` goes as a bearer. */
function authorization(key: string): string {
  if (/^bearer\s/i.test(key)) return key;
  return key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;
}

type Json = Record<string, unknown>;

const record = (value: unknown, what: string): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Linear answered an unexpected shape for ${what}`);
  return value as Json;
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const nodesOf = (value: unknown, what: string): Json[] => {
  const nodes = record(value, what).nodes;
  if (!Array.isArray(nodes)) throw new Error(`Linear answered no nodes for ${what}`);
  return nodes.map((node) => record(node, what));
};

/** Every Linear workspace through the GraphQL API with its own key; `fetch` is the real one unless a test supplies one. */
export function linearPort(options: LinearPortOptions = {}): LinearPort {
  const env = options.env ?? process.env;
  const doFetch: LinearFetch = options.fetch ?? ((url, init) => {
    if (url !== ENDPOINT) throw new Error(`Linear is only reachable at ${ENDPOINT}`);
    return fetch("https://api.linear.app/graphql", init);
  });

  async function graphql(workspace: Workspace, query: string, variables: Json, what: string): Promise<Json> {
    const key = await linearKey(workspace, env, options.keychain);
    const signal = options.signal === undefined
      ? AbortSignal.timeout(LINEAR_REQUEST_BUDGET_MS)
      : AbortSignal.any([options.signal, AbortSignal.timeout(LINEAR_REQUEST_BUDGET_MS)]);
    const response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization(key) },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Linear ${what} answered HTTP ${response.status}: ${body.slice(0, 400)}`);
    let parsed: Json;
    try {
      parsed = record(JSON.parse(body), what);
    } catch (error) {
      throw new Error(`Linear ${what} answered no JSON: ${(error as Error).message}`);
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const messages = parsed.errors.map((entry) => text(record(entry, what).message)).filter((message) => message !== "");
      throw new Error(`Linear ${what} failed: ${messages.join("; ") || JSON.stringify(parsed.errors).slice(0, 400)}`);
    }
    return record(parsed.data, `${what} data`);
  }

  /** The issue's own uuid: a write names the issue by it, never by identifier. */
  async function issueId(workspace: Workspace, ticket: string): Promise<string> {
    const data = await graphql(workspace, "query($id: String!) { issue(id: $id) { id } }", { id: ticket }, `issue ${ticket}`);
    const id = text(record(data.issue, `issue ${ticket}`).id);
    if (id === "") throw new Error(`Linear has no issue ${ticket}`);
    return id;
  }

  async function mutate(workspace: Workspace, query: string, variables: Json, field: string, what: string): Promise<void> {
    const data = await graphql(workspace, query, variables, what);
    if (record(data[field], what).success !== true) throw new Error(`Linear ${what} was refused (success: false)`);
  }

  return {
    async getIssue(workspace, ticket): Promise<Issue> {
      const data = await graphql(
        workspace,
        `query($id: String!) { issue(id: $id) { identifier title description priority createdAt url branchName state { name } attachments(first: 100) { nodes { title url } } } }`,
        { id: ticket },
        `get_issue ${ticket}`,
      );
      const issue = record(data.issue, `issue ${ticket}`);
      const priority = issue.priority;
      if (typeof priority !== "number") throw new Error(`Linear answered no priority for ${ticket}`);
      return {
        identifier: text(issue.identifier),
        title: text(issue.title),
        description: text(issue.description),
        status: text(record(issue.state, `state of ${ticket}`).name),
        priority,
        createdAt: text(issue.createdAt),
        url: text(issue.url),
        gitBranchName: text(issue.branchName),
        attachments: nodesOf(issue.attachments, `attachments of ${ticket}`).map((node) => ({
          ...(typeof node.title === "string" ? { title: node.title } : {}),
          url: text(node.url),
        })),
      };
    },

    /** Every comment, page by page, oldest first. */
    async listComments(workspace, ticket): Promise<Comment[]> {
      const found: Comment[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
        const data = await graphql(
          workspace,
          `query($id: String!, $first: Int!, $after: String) { issue(id: $id) { comments(first: $first, after: $after) { nodes { id body createdAt } pageInfo { hasNextPage endCursor } } } }`,
          { id: ticket, first: COMMENT_PAGE_SIZE, ...(after === undefined ? {} : { after }) },
          `list_comments ${ticket}`,
        );
        const comments = record(record(data.issue, `issue ${ticket}`).comments, `comments of ${ticket}`);
        for (const node of nodesOf(comments, `comments of ${ticket}`)) {
          found.push({ id: text(node.id), body: text(node.body), createdAt: text(node.createdAt) });
        }
        const info = record(comments.pageInfo, `comment pages of ${ticket}`);
        if (info.hasNextPage !== true) return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        after = text(info.endCursor);
        if (after === "") throw new Error(`Linear list_comments ${ticket} says there is another page and gives no cursor`);
      }
      throw new Error(`Linear list_comments ${ticket} has more than ${MAX_COMMENT_PAGES} pages of ${COMMENT_PAGE_SIZE}`);
    },

    async listStatuses(workspace) {
      const data = await graphql(
        workspace,
        `query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { states(first: 250) { nodes { id name } } } } }`,
        { team: workspace.team },
        "list_issue_statuses",
      );
      const [team] = nodesOf(data.teams, "teams");
      if (team === undefined) throw new Error(`Linear has no team ${workspace.team}`);
      return nodesOf(team.states, "workflow states").map((node) => ({ id: text(node.id), name: text(node.name) }));
    },

    async listIssues(workspace, status, project) {
      const found: IssueSummary[] = [];
      const filter: Json = {
        team: { key: { eq: workspace.team } },
        state: { name: { eq: status } },
        ...(project === undefined ? {} : { project: UUID.test(project) ? { id: { eq: project } } : { name: { eq: project } } }),
      };
      let after: string | undefined;
      for (let page = 0; page < MAX_LINEAR_PAGES; page++) {
        const data = await graphql(
          workspace,
          `query($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { identifier priority createdAt state { name } } pageInfo { hasNextPage endCursor } } }`,
          { filter, first: LINEAR_PAGE_SIZE, ...(after === undefined ? {} : { after }) },
          `list_issues ${status}`,
        );
        const issues = record(data.issues, `issues in ${status}`);
        for (const node of nodesOf(issues, `issues in ${status}`)) {
          const priority = node.priority;
          if (typeof priority !== "number") throw new Error(`Linear answered no priority for ${text(node.identifier)}`);
          found.push({
            identifier: text(node.identifier),
            status: text(record(node.state, "state").name),
            priority,
            createdAt: text(node.createdAt),
          });
        }
        const info = record(issues.pageInfo, `pages of ${status}`);
        if (info.hasNextPage !== true) return found;
        after = text(info.endCursor);
        if (after === "") throw new Error(`Linear list_issues ${status} says there is another page and gives no cursor`);
      }
      throw new Error(`Linear list_issues ${status} has more than ${MAX_LINEAR_PAGES} pages of ${LINEAR_PAGE_SIZE}`);
    },

    async saveIssue(workspace, input) {
      const id = await issueId(workspace, input.ticket);
      const update: Json = {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.stateId === undefined ? {} : { stateId: input.stateId }),
      };
      if (Object.keys(update).length > 0) {
        await mutate(
          workspace,
          "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
          { id, input: update },
          "issueUpdate",
          `save_issue ${input.ticket}`,
        );
      }
      if (input.duplicateOf !== undefined) {
        await mutate(
          workspace,
          "mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
          { input: { issueId: id, relatedIssueId: await issueId(workspace, input.duplicateOf), type: "duplicate" } },
          "issueRelationCreate",
          `duplicate ${input.ticket} of ${input.duplicateOf}`,
        );
      }
    },

    async saveComment(workspace, input) {
      await mutate(
        workspace,
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        { input: { issueId: await issueId(workspace, input.ticket), body: input.body } },
        "commentCreate",
        `save_comment ${input.ticket}`,
      );
    },
  };
}
