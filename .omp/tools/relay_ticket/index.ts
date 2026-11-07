import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { defaultDevEnvRoot, devEnvSandbox } from "./dev_env.js";
import { spawnExec } from "./exec.js";
import { parseInput } from "./input.js";
import { landPullRequest, liveLandingPorts } from "./landing.js";
import { authFromEnv, linearPort } from "./linear.js";
import { relayTicket } from "./run.js";
import { DEFAULT_SESSION_MINUTES, MAX_SESSION_MINUTES } from "./types.js";

const HEARTBEAT_MS = 15_000;

const DESCRIPTION =
  "Work one Linear ticket in a throwaway E2B sandbox: lease a sandbox through dev-env's mise tasks, run a headless omp session in it that implements the ticket (clone, branch, commit, push, pull request titled with the ticket identifier and carrying `Fixes <ticket>`), comment the outcome on the ticket, and verify the sandbox is gone, terminating it when the driver left it up. "
  + "Use to hand a ticket's implementation to an isolated machine; make_pr_mergable drives a pull request that already exists. "
  + "Input `{\"ticket\":\"ZYS-123\"}`; optional `repo` (`owner/name`, else the ticket's `## Repository` section, else none: the session clones what it needs), `prompt` and `thread` (`[{\"role\":\"user\"|\"agent\",\"text\":\"…\"}]` for a follow-up turn), `model`, `timeoutMinutes` (default 15, max 30), `settleOnTicket` (default true; false skips the settling comment), `merge` (default false: nothing merges; true lands the session's pull request through upgrade_dependency for a dependency bot, else make_pr_mergable, and a pull request that does not land fails the run). "
  + "Needs LINEAR_API_KEY (or RELAY_LINEAR_TOKEN_FILE), mise, uv, gh and a dev-env checkout (RELAY_TICKET_DEV_ENV, default ~/Developer/Personal/dev-env). "
  + "Side effects: leases a billed sandbox, spends model quota, posts one opening and one settling Linear comment, pushes branches and opens pull requests; landing runs a nested omp session that calls the landing tool. "
  + "Returns { ticket, sandbox, repo?, branch?, status: succeeded|failed, reason?, sessionExit, markers, teardown, progressReported, settled, report, pullRequest?, landing? }. A failed session is returned as status failed; a sandbox that cannot be shown gone throws. Runs up to about 40 minutes with progress updates; not resumable.";

const factory: CustomToolFactory = (pi) => ({
  name: "relay_ticket",
  label: "Relay ticket",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    ticket: pi.zod.string().min(1).describe("Linear ticket identifier like ZYS-3843; the key in LINEAR_API_KEY must belong to that ticket's workspace."),
    repo: pi.zod.string().min(1).nullable().optional().describe("GitHub repository as owner/name to work in. Omit to use the ticket's `## Repository` section, else none."),
    prompt: pi.zod.string().min(1).nullable().optional().describe("This turn's instruction when it is not the last user turn of `thread`. Omit on a first turn: the ticket's title and description are the assignment."),
    thread: pi.zod
      .array(pi.zod.object({ role: pi.zod.enum(["user", "agent"]), text: pi.zod.string().min(1) }))
      .nullable()
      .optional()
      .describe("Earlier turns of the Linear session, oldest first. Omit for a new session."),
    settleOnTicket: pi.zod.boolean().nullable().optional().describe("Post the settling comment on the ticket. Default true; false when the caller delivers `report` itself."),
    merge: pi.zod.boolean().nullable().optional().describe("Land the pull request the session names before reporting done. Default false: nothing merges."),
    model: pi.zod.string().min(1).nullable().optional().describe("omp model for the session. Omit for the session driver's own."),
    timeoutMinutes: pi.zod.number().int().positive().max(MAX_SESSION_MINUTES).nullable().optional().describe(
      `Session time budget in minutes. Default ${DEFAULT_SESSION_MINUTES}, at most ${MAX_SESSION_MINUTES}.`,
    ),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const input = parseInput(params as Record<string, unknown>);
    const devEnv = defaultDevEnvRoot();
    if (!existsSync(devEnv)) throw new Error(`relay_ticket: no dev-env checkout at ${devEnv}; set RELAY_TICKET_DEV_ENV`);
    const credential = authFromEnv();

    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `relay_ticket ${input.ticket}: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const result = await relayTicket(input, {
        // The Linear calls carry no abort signal: the opening and settling comments must still go out after a stop.
        linear: linearPort(credential),
        sandbox: devEnvSandbox(spawnExec, devEnv),
        landPullRequest: (url, options) => landPullRequest(liveLandingPorts(spawnExec, signal), url, options),
        suffix: () => randomBytes(2).toString("hex"),
        step: async (name, fn) => {
          phase = name;
          return fn();
        },
        signal,
      });
      return {
        content: [{ type: "text", text: `${result.report}\n\n(sandbox ${result.sandbox}, teardown ${result.teardown.state}, ${Math.round((Date.now() - began) / 1000)} s)` }],
        details: result,
      };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
