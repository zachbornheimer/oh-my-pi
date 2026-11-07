import type { FacadeFact } from "./schemas.js";

// Port of agentmux internal/depupgrade/facade.go: the facade rule from importer counts. More than one
// file importing the package directly means it needs a facade; a single importer is the facade (owner)
// every other file goes through.

/** facadeSampleSize is how many importer paths a reason names. */
const FACADE_SAMPLE_SIZE = 3;

function sample(paths: string[], n: number): string {
  if (paths.length <= n) return paths.join(", ");
  return paths.slice(0, n).join(", ") + ", ...";
}

/**
 * facadeFor says whether a package needs a facade and who owns it (facade.go facadeFor). The owner is
 * omitted where Go's `omitempty` drops it, so the field is absent rather than empty.
 */
export function facadeFor(importers: string[], exempt: boolean): FacadeFact {
  if (exempt) return { required: false, reason: "exempt from the facade rule by the alias catalog" };
  switch (importers.length) {
    case 0:
      return { required: false, reason: "no file imports it directly" };
    case 1:
      return { required: false, owner: importers[0]!, reason: `one file imports it directly: ${importers[0]!}` };
    default:
      return {
        required: true,
        reason: `${importers.length} files import it directly, e.g. ${sample(importers, FACADE_SAMPLE_SIZE)}`,
      };
  }
}
