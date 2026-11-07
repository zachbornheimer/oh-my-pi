import { securityFinding, type Verdict } from "./check.ts";
import type { HttpAnswer } from "./net.ts";

export const CHECK = "webmaster.security.wordpress.rest_batch";
const OK = 200;
const MULTI_STATUS = 207;

/** Batch routes that ran an anonymous empty batch. */
export function restBatchVerdict(restBatch: readonly HttpAnswer[] | undefined): Verdict {
  if (restBatch === undefined) return { unmeasured: "the public API was not read" };
  if (restBatch.every((asked) => asked.status === 0)) {
    return { unmeasured: `no batch route answered: ${restBatch[0]?.error ?? "no request was sent"}` };
  }
  const open = restBatch.filter((asked) => asked.status === OK || asked.status === MULTI_STATUS).map((asked) =>
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
