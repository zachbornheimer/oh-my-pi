import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { decisionsDirectory, unpinDecision } from "./store.js";

export const DESCRIPTION = [
  "Unpin a decision that is answered or no longer matters (you settled it yourself, or the work moved on). The user's own pick already unpins it, so call this only for stale pins; an unknown id is harmless. Pins are made with `pin_decision`.",
  'Call: `{"id":3}`. `id` is the number `pin_decision` returned. `session` MUST be the one the pin was made in; default: this omp session, which is where `pin_decision` pins by default.',
  "Rules: the question is remembered as answered or dismissed, so pinning the same question again in that session is refused. An id the session does not hold returns status `not_pinned`: a report, never an error.",
  "Writes `$CAPABILITY_DECISIONS_DIR` (default ~/.cache/capability-runtime/decisions)`/<session>.json`; no network and no model.",
  "Returns `{capability, output: {id, status: unpinned|not_pinned, session, text}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "resolve_decision",
    label: "Resolve decision",
    description: DESCRIPTION,
    loadMode: "essential",
    parameters: z.object({
      id: z.number().int().describe("Id returned by pin_decision."),
      session: z.string().min(1).nullable().optional().describe(
        "The band the pin is in, as given to pin_decision. Default: this omp session.",
      ),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      signal?.throwIfAborted();
      const session = params.session ?? ctx?.sessionManager?.getSessionId() ?? "default";
      const found = await unpinDecision(decisionsDirectory(), session, params.id);
      const output = found === undefined
        ? { id: params.id, status: "not_pinned" as const, session, text: `No pinned decision ${params.id}.` }
        : { id: params.id, status: "unpinned" as const, session, text: `Unpinned decision ${params.id}.` };
      // The decision band reads this envelope from the tool result text; keep the shape.
      return { content: [{ type: "text", text: JSON.stringify({ capability: "resolve_decision", output }) }], details: output };
    },
  };
};

export default factory;
