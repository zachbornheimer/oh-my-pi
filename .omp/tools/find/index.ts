import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { judgeCandidates } from "./find.js";
import { keywordsOf } from "./keywords.js";
import { nodeMachine } from "./machine.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { scanForCandidates } from "./scan.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./schemas.js";
import { assertSearchRoot } from "./scope.js";

const DESCRIPTION = [
  "Semantic grep: describe the behavior you are looking for and get the files and line ranges that implement it, ranked by a model. Use it when you do not know the symbol; use `grep` for a literal you already know, `glob` for a path shape, and `orient` to also get state, tests and the test command.",
  'Input `{"query":"where a session id is resolved for a harness","keywords":["session","harness"],"limit":5}`. `keywords` are identifiers to weight in the lexical scan; empty or omitted derives them from the query. `limit` defaults to 10, at most 50.',
  "Scans the session's working directory: lists tracked files (`git ls-files`, else a bounded walk; up to 20000 files, 512 KB each, binaries and dependency or build directories skipped), scores them by keyword, keeps the best 20 with up to 2 passages each, then model runs (`omp -p`, no tools, up to 26 judgments per run, 4 at once) keep files scoring at least 0.35 and passages at least 0.2. Scores are the model's own stated probabilities, not calibrated ones.",
  "REFUSES, before any model call, a working directory that is a home or system root or a known-huge tree such as ~/Developer or ~/Library: start omp in a narrower directory.",
  "Returns JSON `{status, query, hits[{path,start,end,score,snippet}], coverage, filesScanned, fileCap, truncated}`; `path` is absolute and goes straight to `read` and `edit`. Coverage `partial` means the file cap was hit, so `not_found` is not proof of absence.",
  "Never writes; spawns `omp -p` (model quota), a failed model step fails the call.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "find",
    label: "Find",
    loadMode: "essential",
    description: DESCRIPTION,
    parameters: z.object({
      query: z.string().describe("Plain-language description of the behavior to locate. Blank is refused."),
      keywords: z.array(z.string()).nullable().optional().describe(
        "Identifiers to weight in the lexical scan; derived from the query when empty (the default).",
      ),
      limit: z.number().int().min(1).max(MAX_LIMIT).nullable().optional().describe(
        `Most hits to return, best score first. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`,
      ),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const query = params.query.trim();
      if (query === "") throw new Error("find needs the behavior to locate");
      assertSearchRoot("", pi.cwd, "find");
      const given = (params.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword !== "");
      const keywords = given.length === 0 ? keywordsOf(query) : given;
      const output = await withHeartbeat(onUpdate, "find is working", async () => {
        const scan = await scanForCandidates(nodeMachine(pi.exec, pi.cwd, signal), query, keywords);
        return judgeCandidates(query, params.limit ?? DEFAULT_LIMIT, scan, { step: ompModelStep(pi.exec), signal });
      });
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
