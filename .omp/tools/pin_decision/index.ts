import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { pin } from "./pin_decision.js";

export const DESCRIPTION = [
  "Ask the human a question without blocking: pins it in a band above their prompt, answerable with one key. Use it for ANY decision that needs the human (a choice between options, a scope call, credentials, an irreversible step) instead of asking in prose at the end of a reply.",
  "It is not a way to delay work: finish everything that does not depend on the answer first and keep working after pinning; decide anything the code, config, docs, or the user's earlier words already answer; never pin a go-ahead for work you were already asked to do. One decision per pin; put your recommended option first. The choice arrives later as a user message `Decision <id> (<question>): <choice>`; unpin a stale one with `resolve_decision`.",
  'Call: `{"question":"Which database?","options":["SQLite","Postgres"]}`. `question` is one line; `options` are 1-9 non-empty strings (9 hotkeys across all pins). `session` defaults to this omp session. `earlier_user_messages` (newest last) refuses a question whose significant words one of them contains.',
  "Before pinning, a model run (`omp -p`, no tools, tens of seconds) judges the question: if a standard approach exists, an autonomous approach works, there is no correct answer, or it is taste, the pin is REFUSED with the reason; decide with the standard option and report it. A repeat of an open or answered question is refused naming its id. If the judge cannot run, the pin is made and `ask_gate.status` is `unavailable`.",
  "Writes `$CAPABILITY_DECISIONS_DIR` (default ~/.cache/capability-runtime/decisions)`/<session>.json`. Returns `{capability, output: {id, question, options, session, text, ask_gate}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "pin_decision",
    label: "Pin decision",
    description: DESCRIPTION,
    loadMode: "essential",
    parameters: z.object({
      question: z.string().min(1).regex(/^[^\r\n]*$/, "one line").describe("The decision, one line."),
      options: z.array(z.string().min(1)).min(1).max(9).describe(
        "Choices the user can pick with one key, recommended first (at most 9 hotkeys across all pins).",
      ),
      session: z.string().min(1).nullable().optional().describe(
        "The band the pin joins. Default: this omp session, so concurrent sessions never share pins.",
      ),
      earlier_user_messages: z.array(z.string().min(1)).nullable().optional().describe(
        "This session's earlier user messages, newest last. A question whose significant words one of them already contains is refused. Omitted: no such check.",
      ),
    }),

    async execute(_toolCallId, params, onUpdate, ctx, signal) {
      const session = params.session ?? ctx?.sessionManager?.getSessionId() ?? "default";
      const output = await withHeartbeat(onUpdate, "pin_decision is judging the question", () =>
        pin(
          {
            question: params.question,
            options: params.options,
            session,
            earlier_user_messages: params.earlier_user_messages ?? undefined,
          },
          { step: ompModelStep(pi.exec), signal },
        ));
      // The decision band reads this envelope from the tool result text; keep the shape.
      return { content: [{ type: "text", text: JSON.stringify({ capability: "pin_decision", output }) }], details: output };
    },
  };
};

export default factory;
