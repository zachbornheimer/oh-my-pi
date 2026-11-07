import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { createSessionHandoffDoc } from "./handoff.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";

const DESCRIPTION = [
  "Turn one harness session into a takeover handoff Markdown document, with no model call. Use when another agent or provider must resume a session; `get_recent_turns` reads a few turns and `get_annotated_transcript` annotates a whole session.",
  'Input `{"conversation":"omp:latest"}`: `<harness>:<id>` with harness agentmux, grok, claude, cursor, codex, hermes, opencode, copilot, pi, omp; id is a full session id, its start, `latest`, or words of the title where the harness has titles. Mastra chat-thread refs (`mastra:thread:<id>`, Studio URLs) are NOT supported (no Mastra trace store) and are refused, as is any ref that is not `<harness>:<id>`.',
  "Reads the session's transcript files or databases on this machine, read-only; an unknown session fails the call naming the ref. Writes nothing; the same session gives the same document.",
  "The document holds: current goal (first human ask), compacted earlier turns the harness summarized, links (transcript path, working directory, branch, worktrees), status (last turn, session end, tests, git), the last 6 spoken turns, tool failures (max 8), errors seen, side effects (pushes, commits, PRs), subagents (max 8), takeover instructions. The stopped reason is NOT classified.",
  "Returns the Markdown as the text; `details` is `{conversation, markdown, context, source:{path, total_turns}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "create_session_handoff_doc",
    label: "Session handoff doc",
    description: DESCRIPTION,
    parameters: z.object({
      conversation: z
        .string()
        .describe("`<harness>:<id|prefix|latest|title>` of the session to hand off, for example `omp:latest` or `claude:abc-123`."),
    }),
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const output = await createSessionHandoffDoc(params.conversation, transcriptFilesTurnSource());
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: output.markdown }], details: output };
    },
  };
};

export default factory;
