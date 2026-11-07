import type { Comment, Issue, LinearPort, LinearStatus, Workspace } from "./types.js";

/** One GraphQL call: the query and its variables in, the response's `data` out; throws on an HTTP or GraphQL error. */
export type Graphql = (workspace: Workspace, query: string, variables: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const COMMENT_PAGE_SIZE = 100;
/** A runaway bound: 50 pages of 100 comments on one ticket. */
const MAX_COMMENT_PAGES = 50;

/** Where a workspace's credential comes from: `LINEAR_API_KEY_<TEAM>` first, then `LINEAR_API_KEY`. */
export function tokenFromEnv(workspace: Workspace, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env[`LINEAR_API_KEY_${workspace.team.toUpperCase()}`] ?? env.LINEAR_API_KEY;
  return token === undefined || token.trim() === "" ? undefined : token.trim();
}

/** The `Authorization` header for a token: a personal API key (`lin_api_…`) is sent bare, an OAuth access token as a bearer. */
export function authorization(token: string): string {
  return token.startsWith("lin_api_") ? token : `Bearer ${token}`;
}

/**
 * The real GraphQL call against `api.linear.app`, authenticated per workspace from the environment. A missing credential
 * fails the call naming the variables to set, so the tool never answers as though a ticket had been read.
 */
export function linearGraphql(
  options: { fetchImpl?: typeof fetch; token?: (workspace: Workspace) => string | undefined | Promise<string | undefined> } = {},
): Graphql {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenOf = options.token ?? ((workspace: Workspace) => tokenFromEnv(workspace));
  return async (workspace, query, variables, signal) => {
    const token = await tokenOf(workspace);
    if (token === undefined) {
      throw new Error(
        `no Linear credential for the ${workspace.team} workspace: set LINEAR_API_KEY_${workspace.team.toUpperCase()} (or LINEAR_API_KEY) to a Linear API key or OAuth access token that can read and write its tickets`,
      );
    }
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authorization(token) },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await response.text();
    let body: { data?: unknown; errors?: { message?: string }[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Linear answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new Error(`Linear: ${body.errors.map((error) => error.message ?? "unknown error").join("; ")}`);
    }
    if (!response.ok) throw new Error(`Linear answered HTTP ${response.status}: ${text.slice(0, 200)}`);
    if (body.data === undefined || body.data === null) throw new Error("Linear answered no data");
    return body.data;
  };
}

type Obj = Record<string, unknown>;

function obj(value: unknown, what: string): Obj {
  if (typeof value !== "object" || value === null) throw new Error(`Linear answered an unexpected shape for ${what}`);
  return value as Obj;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`Linear answered an unexpected shape for ${what}`);
  return value;
}

function nodes(value: unknown, what: string): Obj[] {
  const list = obj(value, what).nodes;
  if (!Array.isArray(list)) throw new Error(`Linear answered an unexpected shape for ${what}`);
  return list.map((node) => obj(node, what));
}

const ISSUE_QUERY = `query RelayIssue($id: String!) {
  issue(id: $id) {
    id identifier title description priority createdAt url branchName
    state { name }
    attachments { nodes { title url } }
  }
}`;

const COMMENTS_QUERY = `query RelayComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const STATES_QUERY = `query RelayStates($team: String!) {
  teams(filter: { key: { eq: $team } }) { nodes { states { nodes { id name } } } }
}`;

const ISSUE_ID_QUERY = `query RelayIssueId($id: String!) { issue(id: $id) { id } }`;

const UPDATE_MUTATION = `mutation RelayUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const COMMENT_MUTATION = `mutation RelayComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

const DUPLICATE_MUTATION = `mutation RelayDuplicate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

/** Linear's own ticket reads and the writes the relay makes (status, comment, duplicate relation), over `graphql`. */
export function linearPort(graphql: Graphql = linearGraphql()): LinearPort {
  const issueId = async (workspace: Workspace, ticket: string): Promise<string> =>
    text(obj(obj(await graphql(workspace, ISSUE_ID_QUERY, { id: ticket }), "issue id").issue, `issue ${ticket}`).id, `issue ${ticket} id`);

  return {
    async getIssue(workspace, ticket): Promise<Issue> {
      const data = obj(await graphql(workspace, ISSUE_QUERY, { id: ticket }), `issue ${ticket}`);
      if (data.issue === null || data.issue === undefined) throw new Error(`Linear has no issue ${ticket}`);
      const issue = obj(data.issue, `issue ${ticket}`);
      const priority = issue.priority;
      if (typeof priority !== "number") throw new Error(`Linear answered an unexpected shape for issue ${ticket} priority`);
      return {
        identifier: text(issue.identifier, "issue identifier"),
        title: text(issue.title, "issue title"),
        description: typeof issue.description === "string" ? issue.description : "",
        status: text(obj(issue.state, "issue state").name, "issue state name"),
        priority,
        createdAt: text(issue.createdAt, "issue createdAt"),
        url: text(issue.url, "issue url"),
        gitBranchName: typeof issue.branchName === "string" ? issue.branchName : "",
        attachments: nodes(issue.attachments, "issue attachments").map((attachment) => ({
          title: typeof attachment.title === "string" ? attachment.title : null,
          url: text(attachment.url, "attachment url"),
        })),
      };
    },
    /** Every comment, newest page last: all a prompt or a read-back needs. */
    async listComments(workspace, ticket): Promise<Comment[]> {
      const found: Comment[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
        const data = obj(await graphql(workspace, COMMENTS_QUERY, { id: ticket, first: COMMENT_PAGE_SIZE, after }), `comments of ${ticket}`);
        const connection = obj(obj(data.issue, `issue ${ticket}`).comments, `comments of ${ticket}`);
        for (const node of nodes(connection, `comments of ${ticket}`)) {
          found.push({ id: text(node.id, "comment id"), body: text(node.body, "comment body"), createdAt: text(node.createdAt, "comment createdAt") });
        }
        const info = obj(connection.pageInfo, "comments pageInfo");
        if (info.hasNextPage !== true) return found;
        if (typeof info.endCursor !== "string") throw new Error(`Linear says ${ticket} has another page of comments and gives no cursor`);
        after = info.endCursor;
      }
      throw new Error(`${ticket} has more than ${MAX_COMMENT_PAGES} pages of ${COMMENT_PAGE_SIZE} comments`);
    },
    async listStatuses(workspace): Promise<LinearStatus[]> {
      const data = obj(await graphql(workspace, STATES_QUERY, { team: workspace.team }), "team states");
      const [team] = nodes(data.teams, "teams");
      if (team === undefined) throw new Error(`Linear has no team ${workspace.team}`);
      return nodes(team.states, "team states").map((state) => ({ id: text(state.id, "state id"), name: text(state.name, "state name") }));
    },
    async saveIssue(workspace, input): Promise<void> {
      if (input.stateId !== undefined) {
        const answer = obj(await graphql(workspace, UPDATE_MUTATION, { id: input.ticket, input: { stateId: input.stateId } }), "issueUpdate");
        if (obj(answer.issueUpdate, "issueUpdate").success !== true) throw new Error(`Linear refused the status change on ${input.ticket}`);
      }
      if (input.duplicateOf !== undefined) {
        const [issue, original] = await Promise.all([issueId(workspace, input.ticket), issueId(workspace, input.duplicateOf)]);
        const answer = obj(
          await graphql(workspace, DUPLICATE_MUTATION, { input: { issueId: issue, relatedIssueId: original, type: "duplicate" } }),
          "issueRelationCreate",
        );
        if (obj(answer.issueRelationCreate, "issueRelationCreate").success !== true) {
          throw new Error(`Linear refused to mark ${input.ticket} a duplicate of ${input.duplicateOf}`);
        }
      }
    },
    async saveComment(workspace, input): Promise<void> {
      const answer = obj(
        await graphql(workspace, COMMENT_MUTATION, { input: { issueId: await issueId(workspace, input.ticket), body: input.body } }),
        "commentCreate",
      );
      if (obj(answer.commentCreate, "commentCreate").success !== true) throw new Error(`Linear refused the comment on ${input.ticket}`);
    },
  };
}
