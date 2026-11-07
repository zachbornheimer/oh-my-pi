// annotate_step: one session read, deterministically annotated, written to a path that embeds the transcript digest:
// a grown session lands on a different path and so renders a different prompt. No model.
import { annotateTranscript, writeAnnotated } from "./annotated.js";
import type { TurnSource } from "./reader/turn_source.js";
import { type Source, itemsOf, loadTranscript } from "./session_export.js";

/** Reads `source`, annotates every item unless all already carry an annotation, and returns the annotated file's path. */
export async function annotatedTranscriptPath(source: Source, transcripts: TurnSource): Promise<string> {
  const session = await loadTranscript(source, transcripts);
  const annotated = itemsOf(session).every((item) => item.annotation !== undefined)
    ? session
    : await annotateTranscript(session);
  return await writeAnnotated(annotated);
}
