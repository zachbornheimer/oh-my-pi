import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { codeEmbeddingIndex } from "./retrieval.js";
import { requireAbsoluteRepo, scanRepository } from "./gather.js";
import { nodeMachine } from "./machine.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { judgeScan } from "./orient.js";
import { assertSearchRoot } from "./scope.js";
import { MAX_QUESTIONS, type OrientRequest } from "./schemas.js";

const DESCRIPTION = [
  "Locate code in a repository by behavior: returns the line ranges that implement it, the ranges holding state it reads or writes, the tests that would fail if it broke, and the command that runs them. Call it FIRST on code you have not read, instead of a read/grep loop; use `grep` for a literal you already know.",
  'Input `{"behavior":"where hook additionalContext outputs are joined","repo":"/abs/path/repo","questions":["whether any dedupe of context exists"],"limit":5}`.',
  "`repo` MUST be an absolute directory; a relative path and home or system roots are refused. `questions` takes at most 6 side questions answered found/not_found: batch every location question into ONE call. `limit` is hits per facet, default 5, at most 20.",
  "Chunks code by declaration, ranks by embedding cosine fused with BM25 (keyword-only when OPENROUTER_API_KEY is unset or embedding fails, said in `retrieval`), then judges each retrieved range with `omp -p` model runs (tens of seconds). Scores are the model's stated probabilities; hits are at least 0.5.",
  "Returns JSON `{status, repo, behavior, seams[], state[], tests[], gate, answers[], absences[], coverage, filesScanned, fileCap, truncated, retrieval}`; a hit is `{path,start,end,score,evidence}`; a test adds `name` and `gate {command,cwd,basis}` from the nearest manifest (null when none). `absences` mean none among the top-ranked ranges, not none in the repository; coverage `partial` means the 20000-file cap was hit.",
  "Never writes the repository; spends model quota; with OPENROUTER_API_KEY it sends chunk text to OpenRouter and caches vectors under ~/.omp/agent/cache/orient.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "orient",
    label: "Orient",
    loadMode: "essential",
    description: DESCRIPTION,
    parameters: z.object({
      behavior: z.string().describe(
        "What the code does, in plain words; identifiers in any spelling (additionalContext also matches additional_context). Blank is refused.",
      ),
      repo: z.string().describe("Absolute path of the repository (or directory) to orient in. Relative is refused."),
      questions: z.array(z.string()).nullable().optional().describe(
        `At most ${MAX_QUESTIONS} side questions answered separately, each found or not_found, such as whether a cache already exists. Default none.`,
      ),
      limit: z.number().int().min(1).max(20).nullable().optional().describe("Hits per facet. Default 5, at most 20."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const behavior = params.behavior.trim();
      if (behavior === "") throw new Error("orient needs the behavior to locate");
      if (params.repo.trim() === "") throw new Error("orient needs repo, the absolute path of the repository");
      const questions = (params.questions ?? []).map((question) => question.trim());
      if (questions.length > MAX_QUESTIONS) throw new Error(`orient takes at most ${MAX_QUESTIONS} questions`);
      if (questions.some((question) => question === "")) throw new Error("a blank question is refused");
      const repo = requireAbsoluteRepo(params.repo.trim(), pi.cwd);
      assertSearchRoot(repo, pi.cwd, "orient", { allowHuge: existsSync(join(repo, ".git")) });
      const request: OrientRequest = { behavior, repo, questions, limit: params.limit ?? 5 };
      const output = await withHeartbeat(onUpdate, "orient is working", async () => {
        const machine = nodeMachine(pi.exec, pi.cwd, signal);
        const scan = await scanRepository(request, machine, codeEmbeddingIndex(signal), signal);
        return judgeScan(request, scan, { step: ompModelStep(pi.exec), signal });
      });
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
