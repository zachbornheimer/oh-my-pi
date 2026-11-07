/** Seconds between progress updates while the network work runs. */
export const HEARTBEAT_MS = 10_000;

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
