import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

/** One error's message, whatever it is. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How much of a dead worker's output tail a failure answer carries. */
export const ERROR_TAIL_CHARS = 400;

/** The last at most `maxChars` of `text`, trimmed: a bounded tail, never a whole log. */
export function tailOf(text: string, maxChars: number = ERROR_TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

/** Quotes one word for POSIX `sh`: single quotes, with an embedded quote closed and reopened. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The one owner of time that is waited: the wall clock the loop reads, and a wait that ends when
 * the caller cancels. Tests drive the loop with a scripted clock.
 */
export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason when it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (signal?.aborted) {
      reject(signal.reason);
      return promise;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    return promise;
  },
};
