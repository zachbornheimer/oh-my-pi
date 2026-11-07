/** Sleeps `ms`; rejects at once when `signal` aborts, and always clears its timer. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason ?? new Error("cancelled"));
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
