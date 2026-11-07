/**
 * The worker's transcript frames in a session driver's output.
 *
 * dev-env's `e2b-session.sh` copies the container's output to its stderr while the session runs, and the container
 * prints each complete line of the worker's session JSONL in it as `E2B-SESSION-JSONL: <raw line>` (a frame). The relay's
 * stream sidecar reads those frames from this process's own stderr, so they are forwarded the moment they arrive. They are
 * unbounded (a whole transcript), so they never enter a kept copy of the output: that copy is capped at its tail, and
 * frames would push the session's markers and closing reply out of it.
 */

/** The frame shape; dev-env's `e2b-session.sh` owns it and the relay's `relay_stream.py` reads it. */
export const SESSION_FRAME_PREFIX = "E2B-SESSION-JSONL: ";

/** Whether a line that has not ended yet may still turn out to be a frame: it has begun the prefix, or passed it. */
function mayBeFrame(partialLine: string): boolean {
  return partialLine.startsWith(SESSION_FRAME_PREFIX) || SESSION_FRAME_PREFIX.startsWith(partialLine);
}

export interface FrameFilter {
  /** Passes this chunk on and answers the part of it a kept copy takes. */
  push(chunk: string): string;
  /** The stream ended: passes on a held half line and answers the part of it a kept copy takes. */
  end(): string;
}

/**
 * Hands every byte of a stream to `forward` as it arrives, except that a half-written line that may still be a frame is
 * held until its newline: a frame forwarded in pieces could be split by another writer's line appended to the same log,
 * so it goes out whole, in one call. Every other line (and any half line that cannot be a frame) goes out at once. The
 * kept copy the filter answers is the same text minus the frame lines, cut only at line boundaries, so a chunk boundary
 * inside a frame never leaves a fragment of it behind.
 */
export function frameFilter(forward: (text: string) => void): FrameFilter {
  /** The held start of a line that may be a frame: neither forwarded nor kept until the line ends. */
  let held = "";
  /** The current line began without being a frame and part of it is already out: the rest of it is not a line start. */
  let continuing = false;

  return {
    push(chunk) {
      let kept = "";
      let rest = held + chunk;
      held = "";
      while (rest.length > 0) {
        const newline = rest.indexOf("\n");
        if (newline >= 0) {
          const line = rest.slice(0, newline + 1);
          forward(line);
          if (continuing || !line.startsWith(SESSION_FRAME_PREFIX)) kept += line;
          continuing = false;
          rest = rest.slice(newline + 1);
          continue;
        }
        if (!continuing && mayBeFrame(rest)) {
          held = rest;
        } else {
          forward(rest);
          kept += rest;
          continuing = true;
        }
        break;
      }
      return kept;
    },

    end() {
      const rest = held;
      held = "";
      continuing = false;
      if (rest === "") return "";
      forward(rest);
      return rest.startsWith(SESSION_FRAME_PREFIX) ? "" : rest;
    },
  };
}
