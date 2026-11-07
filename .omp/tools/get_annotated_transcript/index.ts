import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { annotateSources } from "./annotate_sources.js";
import { annotatedDirectory } from "./annotated.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";

/** Interval between progress updates while a large session is read. */
const HEARTBEAT_MS = 15_000;

const DESCRIPTION = [
  "Annotate agent sessions without a model: read each source, add a `happened`, `cost`, `waste` and `correction` reading (plus `tokens` and `est_usd` where the transcript recorded usage) to every item, and write it to disk. Use before reviewing or learning from a session; `get_recent_turns` reads a few turns and `create_session_handoff_doc` writes a takeover note.",
  'Input `{"sources":["omp:latest","claude:<id>"],"format":"default"}`. A source is a session-export `.json` path, an omp session file path, or `<harness>:<id>` with harness agentmux, grok, omp, pi, claude, codex, hermes, cursor, copilot, opencode; the id may be a full id, its start, `latest`, or words of the title where the harness has titles (a bare omp session UUID also works).',
  "`format` `default` clips the `happened` text to 160 characters; `raw` keeps it whole. The item itself is never clipped.",
  "Reads up to 4 sources at once; an unreadable or unknown source fails the whole call and returns nothing. A source already fully annotated passes through unchanged. Mastra chat-thread refs are NOT supported here (no Mastra trace store).",
  `Writes \`<conversation>-<digest>.annotated.json\` under ${"`$CAPABILITY_ANNOTATED_DIR`"} (default ~/.local/share/capability-replicas/annotated); a grown session lands on a new file.`,
  "Returns per session `{conversation, path, source, turns, items, corrections, wasted, tokens, est_usd, already_annotated}`; the annotated items are in the file at `path`, NOT in the result: read that file for them.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "get_annotated_transcript",
    label: "Annotated transcript",
    description: DESCRIPTION,
    parameters: z.object({
      sources: z
        .array(z.string())
        .describe("Session-export JSON paths, omp session file paths, or `<harness>:<id|prefix|latest|title>` refs. At least one."),
      format: z
        .enum(["default", "raw"])
        .nullable()
        .optional()
        .describe("`default` (the default) clips each item's `happened` text to 160 characters; `raw` keeps it whole."),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      if (params.sources.length === 0) throw new Error("get_annotated_transcript: `sources` needs at least one session");
      if (params.sources.some((source) => source.trim() === "")) {
        throw new Error("get_annotated_transcript: a source is blank");
      }
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `get_annotated_transcript: annotating ${params.sources.length} source(s) (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { status: "running" },
        });
      }, HEARTBEAT_MS);
      let sessions;
      try {
        sessions = await annotateSources(params.sources, params.format ?? "default", transcriptFilesTurnSource());
      } finally {
        clearInterval(beat);
      }
      signal?.throwIfAborted();
      const details = { directory: annotatedDirectory(), sessions };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
};

export default factory;
