import { webUrl } from "./page_fetch.ts";

/** The text result every tool returns: the typed output as JSON, and again as `details`. */
export function jsonResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

/** The page address a call names, or a thrown message that says what is wrong with it. */
export const pageUrl = (address: string): string => webUrl(address.trim());

export type Update = ((partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined;

/** A progress line to the caller, as a text update. */
export function progressTo(onUpdate: Update): (line: string) => void {
  return (line) => onUpdate?.({ content: [{ type: "text", text: line }], details: { status: "running" } });
}

/** Interval between progress updates while a long step runs. */
export const HEARTBEAT_MS = 15_000;

/** Runs `work`, sending `onUpdate` a progress line every HEARTBEAT_MS until it settles; the timer is always cleared. */
export async function withHeartbeat<T>(onUpdate: Update, label: string, work: () => Promise<T>): Promise<T> {
  const began = Date.now();
  const beat = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text", text: `${label} (${Math.round((Date.now() - began) / 1000)} s)` }],
      details: { status: "running" },
    });
  }, HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
