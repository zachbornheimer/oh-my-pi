import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { withHeartbeat } from "./omp_session.js";
import { liveValidateTicketPorts, runValidateTicket } from "./validate_ticket.js";

const DESCRIPTION = [
  "Check that a Linear ticket still needs doing before anyone works it. It does not if its status is completed or canceled, the repository or a merged pull request already delivers it, or a later ticket supersedes it (`find_superseding_tickets`, run for you unless you pass its result as `supersession`).",
  "An open pull request does not make a ticket not current: unlanded work is not done, so the ticket stays `current` and the pull request is listed as underway; for a superseded ticket it is listed so it can be closed with it.",
  "Call it after `prepare_ticket`, whose status updates it reads.",
  'Call `{"ticket":"ZYS-123"}`; `supersession` needs `verdict`, `superseded_by` and `evidence`, and one that names another ticket is refused.',
  "`gh search prs` finds open pull requests mentioning the ticket under the user's account and organizations; a full omp session with the user's Linear tools reads the ticket and keeps the ones that address it. Its reply MUST be one JSON object with full pull request URLs (asked again, up to 3 attempts).",
  "Read-only: nothing in Linear or GitHub changes. It spawns model sessions (cost, up to 20 minutes each).",
  "Returns `{ticket, verdict, reasons, status, status_type, already_resolved, open_pull_requests:[{url,title}], superseded_by, pull_request_search, evidence}`.",
  "`verdict` is `current`, `not_current` (reasons say why) or `unverified` (a check could not run; reasons say which; `status`, `status_type`, `already_resolved` are null when the review did not answer).",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const supersession = z.object({
    ticket: z.string().nullable().optional().describe("The ticket the result is for; when present it MUST be this ticket."),
    verdict: z.enum(["superseded", "not_superseded", "unverified"]).describe("find_superseding_tickets' verdict."),
    filed_at: z.string().nullable().optional().describe("When the ticket was filed, ISO 8601."),
    superseded_by: z
      .array(z.object({ id: z.string(), filed_at: z.string(), why: z.string() }))
      .describe("Every later ticket that supersedes it; empty unless `superseded`."),
    rejected: z
      .array(z.object({ id: z.string(), reason: z.string() }))
      .nullable()
      .optional()
      .describe("Candidates that were dropped, with why."),
    evidence: z.string().describe("What was searched, or why the check did not answer."),
  });
  return {
    name: "validate_ticket",
    label: "Validate ticket",
    description: DESCRIPTION,
    parameters: z.object({
      ticket: z.string().min(1).describe("The Linear ticket identifier, such as ZYS-123 or SAH-123."),
      supersession: supersession
        .nullable()
        .optional()
        .describe("The result of find_superseding_tickets for this ticket, when already run. Omitted: validate_ticket runs it."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "validate_ticket is working", () =>
        runValidateTicket(
          { ticket: params.ticket, supersession: params.supersession ?? undefined },
          liveValidateTicketPorts({ exec: pi.exec, signal, cwd: pi.cwd }),
          signal,
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
