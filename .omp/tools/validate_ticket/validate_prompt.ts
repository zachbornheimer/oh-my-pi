import { NO_RECURSION } from "./omp_session.js";

/** The validation question, copied from the Mastra capability's `validate_ticket.yaml` and adapted to a full omp session that answers in JSON. */
export function validationPrompt(ticket: string, pullRequestCandidates: string): string {
  return `Check whether Linear ticket ${ticket} is still current: still open work that nobody has started or finished. This is a
read-only check. Do not edit the ticket, comment on it, or change its status. Read it in Linear (body, every comment,
status, attachments and linked pull requests); Linear tools are not preloaded: find them with tool_search.

Report:
- status: the exact name of the ticket's status now. status_type: Linear's type for that status, one of backlog,
  unstarted, started, completed, canceled.
- already_resolved: true only when the repository or a merged pull request already delivers what the ticket asks for.
  Verify it in the code or the merged pull request; the ticket's own claim that it is done does not count, and an open
  or partial pull request is not delivery: work that has not landed is not done.
- open_pull_requests: every open pull request that addresses this ticket, by url. Start from the candidates below,
  which are a search of the user's GitHub accounts for the ticket id and so include pull requests that merely mention
  it: drop those. Add any open pull request the ticket links in Linear (attachments, comments), after checking with
  \`gh pr view <url> --json state\` that it is still open. A closed or merged pull request is not listed.
- evidence: one or two sentences naming what you checked and what decided each answer.

Open pull request candidates:
${pullRequestCandidates}

${NO_RECURSION}

## Your answer

Reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"status": "<exact status name>", "status_type": "backlog|unstarted|started|completed|canceled", "already_resolved": <boolean>, "open_pull_requests": ["https://github.com/<owner>/<repo>/pull/<n>"], "evidence": "<what was checked and what decided each answer>"}
Every field is required; open_pull_requests may be [] and every entry MUST be a full pull request URL.

Examples:
- Linear ticket ZYS-1 is Backlog. Nothing in the repository does what it asks and no pull request mentions it.
  {"status":"Backlog","status_type":"backlog","already_resolved":false,"open_pull_requests":[],"evidence":"The endpoint it asks for is absent from the router; a search of the repository and of Linear's attachments found no pull request."}
- Linear ticket ZYS-2 is In Progress. Its attachment is open pull request https://github.com/zysys/example/pull/7.
  {"status":"In Progress","status_type":"started","already_resolved":false,"open_pull_requests":["https://github.com/zysys/example/pull/7"],"evidence":"gh pr view reports pull request 7 open and its description closes ZYS-2."}`;
}
