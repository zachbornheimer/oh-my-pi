import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { withHeartbeat } from "./omp_session.js";
import { runPrepareTicket } from "./prepare_ticket.js";

const DESCRIPTION = [
  "Prepare one Linear ticket for the next worker: a full omp session with the user's own tools reads the whole ticket (body, every comment, metadata, history), researches the complaint on the web when the repository does not make it clear, rewrites it per the tickets skill, updates its tags, related issues and status so the status is true, and links an in-progress pull request when one exists.",
  "Use it before `validate_ticket` and `relay`; root-cause review is not part of it.",
  'Call `{"ticket":"ZYS-123"}`; the identifier MUST be a Linear identifier (`ABC-123`, upper-cased for you), anything else is refused before a session starts.',
  "It WRITES to Linear (description, comments, labels, relations, status) through the session's own tools, runs up to 30 minutes, is not resumable, and a killed run can leave partial edits: call it once per ticket.",
  "The session's reply MUST be one JSON object; a bad one is asked again from the ticket's saved state (edits are not repeated), up to 3 attempts, then the call fails.",
  "Returns `{ready_for_work, status, reason?, thread}`: `ready_for_work` and `status` are the agent's own report, NOT re-read from Linear; `reason` appears only when not ready; `thread` is the session transcript path, empty when omp wrote none.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "prepare_ticket",
    label: "Prepare ticket",
    description: DESCRIPTION,
    parameters: z.object({
      ticket: z.string().min(1).describe("The Linear ticket identifier, such as ZYS-123 or SAH-123."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "prepare_ticket is working", () =>
        runPrepareTicket({ ticket: params.ticket }, { exec: pi.exec, signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
