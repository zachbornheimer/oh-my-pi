import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runFindSupersedingTickets } from "./find_superseding_tickets.js";
import { withHeartbeat } from "./omp_session.js";

const DESCRIPTION = [
  "Find the Linear tickets filed after a given ticket that supersede it, meaning finishing them makes the ticket's whole ask unnecessary.",
  "Use it on a ticket that may have been overtaken; `validate_ticket` runs it for you unless you pass its result as `supersession`.",
  'Call `{"ticket":"ZYS-123"}`: a Linear identifier, upper-cased for you; anything else is refused.',
  "A full omp session with the user's own Linear tools reads the ticket and searches every status; its reply MUST be one JSON object (asked again, up to 3 attempts).",
  "The filing dates are then checked in code: a candidate not filed strictly after the ticket, the ticket itself, a repeat or a non-identifier goes to `rejected`. Overlapping or sibling tickets do not count.",
  "Read-only: nothing in Linear changes. It spawns a model session (cost, up to 20 minutes).",
  "Returns `{ticket, verdict, filed_at, superseded_by:[{id,filed_at,why}], rejected:[{id,reason}], evidence}`.",
  "`verdict` is `superseded`, `not_superseded`, or `unverified` when the session failed or gave no valid reply (`evidence` says why; never reported as `not_superseded`).",
  "Candidates and dates are the session's report, not re-read from Linear.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "find_superseding_tickets",
    label: "Find superseding tickets",
    description: DESCRIPTION,
    parameters: z.object({
      ticket: z.string().min(1).describe("The Linear ticket identifier, such as ZYS-123 or SAH-123."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "find_superseding_tickets is working", () =>
        runFindSupersedingTickets({ ticket: params.ticket }, { exec: pi.exec, signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
