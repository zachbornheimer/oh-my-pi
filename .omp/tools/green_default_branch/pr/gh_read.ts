import { GH_READ_MAX_ATTEMPTS, GH_READ_RETRY_BASE_MS, GH_READ_RETRY_MAX_MS } from "./constants.js";
import type { GitHubPorts } from "./ports.js";

/** `gh` words an HTTP failure as `gh: HTTP 500` or `gh: Server Error (HTTP 502)`. */
const HTTP_STATUS = /\bHTTP (\d{3})\b/;
/** A failure that never reached a status: the connection, DNS or TLS failed, or the call timed out. */
const NETWORK_FAILURE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|i\/o timeout|timed out|timeout|connection reset|TLS handshake|unexpected EOF/i;

/** The HTTP status `gh` reported, or `undefined` when its failure carries none. */
function statusOf(message: string): number | undefined {
  const status = HTTP_STATUS.exec(message)?.[1];
  return status === undefined ? undefined : Number(status);
}

/** A failure another read can clear: any 5xx, or a network failure or timeout. A 4xx is GitHub's answer, never retried. */
function isTransient(message: string): boolean {
  const status = statusOf(message);
  return status === undefined ? NETWORK_FAILURE.test(message) : status >= 500 && status <= 599;
}

/** How long before retry number `retry` (1-based): the base delay doubled per retry, capped, then jittered upward by up to a quarter. */
export function retryDelayMs(retry: number, random: () => number): number {
  const backoff = Math.min(GH_READ_RETRY_BASE_MS * 2 ** (retry - 1), GH_READ_RETRY_MAX_MS);
  return Math.round(backoff * (1 + 0.25 * random()));
}

/**
 * Runs one idempotent `gh` read, asking again after a transient failure (`isTransient`) up to `GH_READ_MAX_ATTEMPTS`
 * attempts with exponential backoff, waited on `ports.sleep`. A failure that is not transient rethrows as it was at
 * once; a transient one that outlasts the bound throws naming the endpoint, the status and the attempts made.
 */
export async function ghRead(ports: GitHubPorts, args: readonly string[], random: () => number = Math.random): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ports.gh(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isTransient(message)) throw error;
      if (attempt >= GH_READ_MAX_ATTEMPTS) {
        const status = statusOf(message);
        throw new Error(
          `gh ${args.slice(0, 3).join(" ")} failed after ${attempt} attempts: ${
            status === undefined ? "network failure" : `HTTP ${status}`
          }: ${message}`,
          { cause: error },
        );
      }
      await ports.sleep(retryDelayMs(attempt, random));
    }
  }
}
