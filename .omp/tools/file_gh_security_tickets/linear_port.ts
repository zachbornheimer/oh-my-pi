import { LINEAR_PAGE_SIZE, MAX_LINEAR_PAGES } from "./constants.js";
import type { SecurityLinearPort } from "./ports.js";
import type { Workspace } from "./workspaces.js";

const ENDPOINT = "https://api.linear.app/graphql";
const REQUEST_BUDGET_MS = 30_000;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 20;

/** The shape of `fetch` this port needs, so a test supplies its own. */
export type LinearFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type LinearPortOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: LinearFetch;
  /** Stops every request when the tool call is cancelled. */
  signal?: AbortSignal;
};

/** The key the workspace's requests are made with: its own variable, else the shared `LINEAR_API_KEY`. */
export function linearKey(workspace: Workspace, env: Readonly<Record<string, string | undefined>>): string {
  const key = env[workspace.apiKeyEnv]?.trim() || env.LINEAR_API_KEY?.trim();
  if (key === undefined || key === "") {
    throw new Error(
      `no Linear API key for the ${workspace.team} workspace: set ${workspace.apiKeyEnv} (or LINEAR_API_KEY) in the omp process environment`,
    );
  }
  return key;
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

/** Linear through the GraphQL API with the workspace's own key; `fetch` is the real one unless a test supplies one. */
export function securityLinearPort(options: LinearPortOptions = {}): SecurityLinearPort {
  const env = options.env ?? process.env;
  const doFetch: LinearFetch = options.fetch ?? ((url, init) => {
    if (url !== ENDPOINT) throw new Error(`Linear is only reachable at ${ENDPOINT}`);
    return fetch("https://api.linear.app/graphql", init);
  });
  const teamIds = new Map<string, string>();

  async function graphql(workspace: Workspace, query: string, variables: Json, what: string): Promise<Json> {
    const key = linearKey(workspace, env);
    const budget = AbortSignal.timeout(REQUEST_BUDGET_MS);
    const response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization(key) },
      body: JSON.stringify({ query, variables }),
      signal: options.signal === undefined ? budget : AbortSignal.any([options.signal, budget]),
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

  async function teamId(workspace: Workspace): Promise<string> {
    const known = teamIds.get(workspace.team);
    if (known !== undefined) return known;
    const data = await graphql(
      workspace,
      "query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id } } }",
      { team: workspace.team },
      `team ${workspace.team}`,
    );
    const [team] = nodesOf(data.teams, "teams");
    const id = text(team?.id);
    if (id === "") throw new Error(`Linear has no team ${workspace.team}`);
    teamIds.set(workspace.team, id);
    return id;
  }

  return {
    async searchIssues(workspace, needle) {
      const found: { identifier: string; title: string; status: string }[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_LINEAR_PAGES; page += 1) {
        const data = await graphql(
          workspace,
          `query($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { identifier title state { name } } pageInfo { hasNextPage endCursor } } }`,
          {
            filter: { team: { key: { eq: workspace.team } }, title: { contains: needle } },
            first: LINEAR_PAGE_SIZE,
            ...(after === undefined ? {} : { after }),
          },
          `list_issues ${needle}`,
        );
        const issues = record(data.issues, `issues carrying ${needle}`);
        for (const node of nodesOf(issues, `issues carrying ${needle}`)) {
          found.push({
            identifier: text(node.identifier),
            title: text(node.title),
            status: text(record(node.state, "state").name),
          });
        }
        const info = record(issues.pageInfo, "issue pages");
        if (info.hasNextPage !== true) return found;
        after = text(info.endCursor);
        if (after === "") throw new Error("Linear list_issues says there is another page and gives no cursor");
      }
      throw new Error(`Linear list_issues has more than ${MAX_LINEAR_PAGES} pages of ${LINEAR_PAGE_SIZE}`);
    },

    async listStatuses(workspace) {
      const data = await graphql(
        workspace,
        "query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { states(first: 250) { nodes { id name } } } } }",
        { team: workspace.team },
        "list_issue_statuses",
      );
      const [team] = nodesOf(data.teams, "teams");
      if (team === undefined) throw new Error(`Linear has no team ${workspace.team}`);
      return nodesOf(team.states, "workflow states").map((node) => ({ id: text(node.id), name: text(node.name) }));
    },

    async findLabel(workspace, name) {
      const data = await graphql(
        workspace,
        "query($name: String!) { issueLabels(filter: { name: { eq: $name } }, first: 100) { nodes { id name team { key } } } }",
        { name },
        `list_issue_labels ${name}`,
      );
      for (const node of nodesOf(data.issueLabels, "labels")) {
        const team = node.team === null || node.team === undefined ? undefined : record(node.team, "label team");
        // A workspace label has no team; a team label is usable only by its own team.
        if (team === undefined || text(team.key) === workspace.team) return { id: text(node.id), name: text(node.name) };
      }
      return undefined;
    },

    async getIssue(workspace, ticket) {
      const data = await graphql(
        workspace,
        "query($id: String!) { issue(id: $id) { identifier title description state { name } } }",
        { id: ticket },
        `get_issue ${ticket}`,
      );
      const issue = record(data.issue, `issue ${ticket}`);
      return {
        identifier: text(issue.identifier) || ticket,
        title: text(issue.title),
        description: text(issue.description),
        status: text(record(issue.state, `state of ${ticket}`).name),
      };
    },

    async createIssue(workspace, input) {
      const data = await graphql(
        workspace,
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }",
        {
          input: {
            teamId: await teamId(workspace),
            title: input.title,
            description: input.description,
            priority: input.priority,
            stateId: input.stateId,
            ...(input.labelIds === undefined || input.labelIds.length === 0 ? {} : { labelIds: [...input.labelIds] }),
          },
        },
        "issueCreate",
      );
      const created = record(data.issueCreate, "issueCreate");
      const identifier = created.success === true && created.issue !== null && created.issue !== undefined
        ? text(record(created.issue, "created issue").identifier)
        : "";
      if (identifier === "") {
        throw new Error(`Linear issueCreate answered no identifier for the created issue: ${JSON.stringify(created).slice(0, 300)}`);
      }
      return { identifier };
    },

    async saveIssueState(workspace, input) {
      const data = await graphql(
        workspace,
        "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        { id: await issueId(workspace, input.ticket), input: { stateId: input.stateId } },
        `save_issue ${input.ticket}`,
      );
      if (record(data.issueUpdate, "issueUpdate").success !== true) {
        throw new Error(`Linear save_issue ${input.ticket} was refused (success: false)`);
      }
    },

    async saveComment(workspace, input) {
      const data = await graphql(
        workspace,
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        { input: { issueId: await issueId(workspace, input.ticket), body: input.body } },
        `save_comment ${input.ticket}`,
      );
      if (record(data.commentCreate, "commentCreate").success !== true) {
        throw new Error(`Linear save_comment ${input.ticket} was refused (success: false)`);
      }
    },

    async listComments(workspace, ticket) {
      const found: { body: string }[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
        const data = await graphql(
          workspace,
          "query($id: String!, $first: Int!, $after: String) { issue(id: $id) { comments(first: $first, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } } }",
          { id: ticket, first: COMMENT_PAGE_SIZE, ...(after === undefined ? {} : { after }) },
          `list_comments ${ticket}`,
        );
        const comments = record(record(data.issue, `issue ${ticket}`).comments, `comments of ${ticket}`);
        for (const node of nodesOf(comments, `comments of ${ticket}`)) found.push({ body: text(node.body) });
        const info = record(comments.pageInfo, `comment pages of ${ticket}`);
        if (info.hasNextPage !== true) return found;
        after = text(info.endCursor);
        if (after === "") throw new Error(`Linear list_comments ${ticket} says there is another page and gives no cursor`);
      }
      throw new Error(`Linear list_comments ${ticket} has more than ${MAX_COMMENT_PAGES} pages of ${COMMENT_PAGE_SIZE}`);
    },
  };
}
