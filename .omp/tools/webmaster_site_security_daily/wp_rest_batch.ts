import { securityFinding, type Verdict } from "./check";
import { type WordpressPublicApi } from "./public_api";

export const CHECK = "webmaster.security.wordpress.rest_batch";
const OK = 200;
const MULTI_STATUS = 207;

/** Batch routes that ran an anonymous empty batch. */
export function restBatchVerdict(api: WordpressPublicApi | undefined): Verdict {
  if (api?.status !== "measured") return { unmeasured: api?.reason ?? "the public API was not read" };
  if (api.rest_batch.every((asked) => asked.status === 0)) {
    return { unmeasured: `no batch route answered: ${api.rest_batch[0]?.error ?? "no request was sent"}` };
  }
  const open = api.rest_batch.filter((asked) => asked.status === OK || asked.status === MULTI_STATUS).map((asked) =>
    `${asked.method} ${asked.path} answered ${asked.status}`
  );
  if (open.length === 0) return [];
  return [securityFinding(
    "security.wordpress.rest_batch",
    "high",
    `The REST batch endpoint takes anonymous batches (an empty batch was sent): ${open.join("; ")}. An anonymous `
      + "batch can reach every REST route a plugin registers.",
    "Block /wp-json/batch/v1 and ?rest_route=/batch/v1 for anonymous visitors at the edge or with a must-use plugin.",
    "Require authentication for the batch route and keep every plugin that registers REST routes patched.",
  )];
}
