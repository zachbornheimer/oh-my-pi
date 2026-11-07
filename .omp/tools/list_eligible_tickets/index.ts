import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { liveEligiblePorts, listEligibleTickets } from "./list_eligible_tickets.js";
import { withHeartbeat } from "./omp_session.js";
import { knownTeams } from "./workspaces.js";

const DESCRIPTION = [
  `Read-only: list the Linear tickets the software factory works next, as identifiers. For each configured workspace (default every one: ${knownTeams()}; \`teams\` names some) a full omp session with the user's Linear tools reads the team's tickets in its own input statuses (SAH: Triage, Unreviewed, Ready for Dev; ZYS: Unreviewed, Ready for Development), only in \`project\` when one is named.`,
  "Tickets from all workspaces are ordered together by priority (Urgent first, No priority last), then oldest first, and the first `limit` (default 1) are returned.",
  'Call `{}` or `{"teams":["ZYS"],"project":"AI Tooling","limit":5}`.',
  "A workspace that has no project of that name contributes nothing; an unknown team, a listing that is not complete or not valid (asked again, up to 3 attempts), or any other failure throws.",
  "The session's listing is checked in code (team key, input status, priority 0-4, date) but not re-read from Linear.",
  "It spawns one model session per workspace in parallel (cost, up to 10 minutes) and changes nothing.",
  'Returns `{"tickets":["ZYS-123","SAH-7"]}`: identifiers only. Use `prepare_ticket` to prepare one, `optimize_tooling` to work them.',
].join(" ");

// omp's zod reports a failed constraint as `must be <description> (was <value>)`, so this text is worded as a constraint.
const LIMIT_EXPECTATION = "an integer of at least 1 (the most identifiers to return; default 1, null for the default)";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "list_eligible_tickets",
    label: "List eligible tickets",
    description: DESCRIPTION,
    parameters: z.object({
      teams: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(`Team keys to read, such as ["ZYS"]. Omitted: every configured workspace (${knownTeams()}).`),
      project: z.string().min(1).nullable().optional().describe("A Linear project name; only its tickets count. Omitted: every project."),
      limit: z.number().int().positive().nullable().optional().describe(LIMIT_EXPECTATION),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const tickets = await withHeartbeat(onUpdate, "list_eligible_tickets is working", () =>
        listEligibleTickets(liveEligiblePorts({ exec: pi.exec, signal, cwd: pi.cwd }), {
          ...(params.teams == null ? {} : { teams: params.teams }),
          ...(params.project == null ? {} : { project: params.project }),
          ...(params.limit == null ? {} : { limit: params.limit }),
        }));
      const output = { tickets };
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;