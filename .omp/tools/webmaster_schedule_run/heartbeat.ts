/** Milliseconds between progress updates while a run works. */
export const HEARTBEAT_MS = 15_000;

/** The slice of omp's `onUpdate` callback this tool uses. */
export type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Runs `work`, sending an `onUpdate` line every `everyMs` until it settles; the timer is always cleared. */
export async function withHeartbeat<T>(
  onUpdate: Update | undefined,
  label: string,
  work: () => Promise<T>,
  everyMs: number = HEARTBEAT_MS,
): Promise<T> {
  const began = Date.now();
  const beat = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text", text: `${label} (${Math.round((Date.now() - began) / 1000)} s)` }],
      details: { status: "running" },
    });
  }, everyMs);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
