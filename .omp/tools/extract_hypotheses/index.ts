import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type Reviewed, extractHypotheses } from "./extract.js";
import { ompSessionStep, withHeartbeat } from "./omp_session.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";

const DESCRIPTION = [
  "Review whole agent sessions adversarially and write one forensics report per session: ask an Execution Forensics agent, run as a full `omp -p` session, for an extensive turn-by-turn list of learnings, competing options and token or step savings. Use before `learn` when the user asks what a session wasted or how agents could do better; `get_annotated_transcript` only annotates and `get_recent_turns` only reads.",
  'Input `{"sources":["omp:latest","claude:<id>","/path/session.annotated.json"]}`. A source is a session-export `.json` path (an `*.annotated.json` is read as is), an omp session file, or `<harness>:<id>` with harness agentmux, grok, omp, pi, claude, codex, hermes, cursor, copilot, opencode. Mastra chat-thread refs (`mastra:thread:<id>`, Studio URLs) are NOT supported: no Mastra trace store.',
  "Steps: annotate each source, write the export under `$CAPABILITY_ANNOTATED_DIR` (default ~/.local/share/capability-replicas/annotated), reuse a non-blank `<conversation>.review.md` already there (a review is bought once), otherwise run the forensics session and write its reply to that path. Two reviews run at once; each can take many minutes and spends model quota.",
  "Fails the whole call on an unreadable source, a non-zero exit, a timeout (45 min) or an empty reply; nothing is faked.",
  "Returns per session `{conversation, annotated_path, review_path, report_markdown}` in `details`; `content` lists the paths and a short preview, so read `review_path` for the full report.",
].join(" ");

/** Characters of each report shown in the model-facing text. */
const PREVIEW_CHARS = 600;

function textOf(reviews: readonly Reviewed[]): string {
  return reviews
    .map((review) => {
      const preview = review.report_markdown.trim().slice(0, PREVIEW_CHARS);
      const more = review.report_markdown.trim().length > PREVIEW_CHARS ? "\n…" : "";
      return [
        `${review.conversation}`,
        `annotated_path: ${review.annotated_path}`,
        `review_path: ${review.review_path}`,
        `preview:\n${preview}${more}`,
      ].join("\n");
    })
    .join("\n\n");
}

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "extract_hypotheses",
    label: "Extract hypotheses",
    description: DESCRIPTION,
    parameters: z.object({
      sources: z
        .array(z.string())
        .describe(
          "Session-export `.json` or `*.annotated.json` paths, omp session file paths, or `<harness>:<id|prefix|latest|title>` refs. At least one; no Mastra chat-thread refs.",
        ),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      if (params.sources.length === 0) throw new Error("extract_hypotheses: `sources` needs at least one session");
      for (const source of params.sources) {
        if (source.trim() === "") throw new Error("extract_hypotheses: a source is blank");
        if (/^mastra:thread:|^https?:\/\//.test(source.trim())) {
          throw new Error(`extract_hypotheses: ${source} is a Mastra chat-thread ref; this tool has no Mastra trace store`);
        }
      }
      let status = "annotating";
      const reviews = await withHeartbeat(
        onUpdate,
        () => `extract_hypotheses: ${status}`,
        () =>
          extractHypotheses(params.sources, {
            transcripts: transcriptFilesTurnSource(),
            step: ompSessionStep(pi.exec as never, { label: "forensics session" }),
            log: (line) => {
              status = line;
            },
            signal,
          }),
      );
      return { content: [{ type: "text", text: textOf(reviews) }], details: { reviews } };
    },
  };
};

export default factory;
