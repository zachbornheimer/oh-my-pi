import { abortReason } from "./text.js";

/**
 * The one owner of time that is waited: the wall clock the lifecycle reads, and a sleep that ends
 * when the caller cancels. Tests drive the lifecycle with a scripted clock.
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
      reject(abortReason(signal));
      return promise;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    return promise;
  },
};
