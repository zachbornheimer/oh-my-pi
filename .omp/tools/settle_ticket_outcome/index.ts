import { setTimeout as delay } from "node:timers/promises";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { githubPort } from "./github.js";
import { linearSessionPort } from "./linear.js";
import { withHeartbeat } from "./omp_session.js";
import { settleTicketOutcome } from "./settle_ticket_outcome.js";
import { OUTCOMES } from "./texts.js";

const DESCRIPTION = [
  "WRITES to GitHub and Linear: end a ticket's run by its outcome. It closes the linked open pull requests when the outcome makes them pointless, sets the ticket's status in its workspace (SAH or ZYS names), and posts one comment with the summary, concerns and evidence.",
  "Status by outcome: `undecipherable`, `needs_info`, `blocked` the not-ready status; `obsolete` Canceled; `already_done`, `work_completed` Done; `superseded` Duplicate when `supersededBy` names another ticket, else Canceled; `pr_ready` Pull Request. `busy` is refused.",
  'Call `{"ticket":"ZYS-9","closing":{"outcome":"superseded","summary":"Superseded by ZYS-14.","concerns":[],"evidence":["ZYS-14 covers it"],"supersededBy":"ZYS-14","closeLinkedPullRequest":true},"linkedPulls":["https://github.com/zachbornheimer/app/pull/7"]}`; `pullRequest` `{url,number,draft}` is the pull request to cite.',
  "Pull requests close (with a comment) only for `obsolete`, `superseded`, and `already_done` with `closeLinkedPullRequest` true. Each MUST be a github.com pull request URL in an organisation the factory owns, else the whole call is refused before any write; each close is read back CLOSED.",
  "A full omp session with the user's Linear tools writes status and comment; a separate read-only session must show both, or the call fails. A failure after pull requests are closed does not reopen them; do not call it twice for one outcome.",
  "Returns `{status, closedPullRequests}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "settle_ticket_outcome",
    label: "Settle ticket outcome",
    description: DESCRIPTION,
    parameters: z.object({
      ticket: z.string().min(1).describe("The Linear ticket, such as SAH-123 or ZYS-45: its prefix names the workspace."),
      closing: z
        .object({
          outcome: z.enum(OUTCOMES).describe("How the run ended."),
          summary: z.string().describe("What happened, in a sentence or two; the comment's lead."),
          concerns: z.array(z.string()).describe("Outstanding concerns or blocking questions; [] when none."),
          evidence: z.array(z.string()).describe("What the outcome rests on; [] when none."),
          supersededBy: z.string().nullable().optional().describe("The ticket that supersedes this one, for `superseded`."),
          closeLinkedPullRequest: z.boolean().describe("For `already_done`: close the linked open pull requests as redundant. Ignored by the other outcomes."),
        })
        .describe("How the run ended."),
      linkedPulls: z
        .array(z.union([z.string(), z.object({ url: z.string() })]))
        .describe("The pull requests linked to the ticket: URLs, or objects carrying one; [] when none."),
      pullRequest: z
        .object({ url: z.string(), number: z.number().int(), draft: z.boolean() })
        .nullable()
        .optional()
        .describe("The pull request the run published, to cite in the comment."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "settle_ticket_outcome is working", () =>
        settleTicketOutcome(
          {
            ticket: params.ticket,
            closing: { ...params.closing, supersededBy: params.closing.supersededBy ?? undefined },
            linkedPulls: params.linkedPulls,
            pullRequest: params.pullRequest ?? undefined,
          },
          {
            github: githubPort(pi.exec, { signal, cwd: pi.cwd }),
            linear: linearSessionPort({ exec: pi.exec, signal, cwd: pi.cwd }),
            sleep: (ms) => delay(ms, undefined, { signal }),
          },
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
