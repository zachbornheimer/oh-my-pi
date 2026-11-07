import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { collectFailureEvidence, evidenceRepositoryRoot, formatEvidence } from "./collect.js";

const DESCRIPTION =
  "Collect bounded, read-only source evidence for one failing TypeScript capability: the schema field that failed, the output contract, the model call and the returned value. "
  + "Use when an error names a capability or a source path and you need the exact code before deciding on a fix; it does not diagnose, edit, or run tests (classify_failure picks the next action from a verification outcome, fix_red_ci repairs a pull request's CI). "
  + "Input `{\"error\":\"capability failed: summarize returned an invalid output: focus: Invalid input: expected array, received undefined\",\"maxTokens\":1000}`. "
  + "error is the exact error text, 1 to 8000 characters. maxTokens is 250 to 2500 (default 1000; about 3 characters each) and caps how much source comes back. "
  + "Files are found from `capability failed: <name>` or `invalid input|output for <name>` (in `src/capability/<name>/<name>.ts` and `schemas.ts`, also under `mastra/`) and from `src/...ts[:line]` paths in the error text. "
  + "The repository root is EVIDENCE_REPOSITORY_ROOT, else the session working directory: never an input field, and files that resolve outside it (including through symlinks) are never read. "
  + "Searches use the ast-grep binary, which MUST be on PATH; without it the call throws `ast-grep is not installed or is missing from PATH`. "
  + "Returns status found or not_found, evidence[] (kind output-field, output-contract, model-contract, model-call or return-value; file; 1-based startLine and endLine; excerpt of at most 800 characters), truncated, estimatedTokens and wallMs. An evidence kind with no match is absent, not reported. Spawns ast-grep only; no network, nothing written.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "collect_failure_evidence",
    label: "Collect Failure Evidence",
    description: DESCRIPTION,
    parameters: z.object({
      error: z.string().describe("Exact error text, including the failing capability name or a `src/...ts:line` location. 1 to 8000 characters."),
      maxTokens: z.number().int().nullable().optional().describe("Token budget, 250 to 2500, default 1000; bounds how much source evidence comes back."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      const maxTokens = params.maxTokens ?? 1_000;
      if (params.error.length < 1 || params.error.length > 8_000) {
        throw new Error("collect_failure_evidence: error must be 1 to 8000 characters");
      }
      if (!Number.isInteger(maxTokens) || maxTokens < 250 || maxTokens > 2_500) {
        throw new Error("collect_failure_evidence: maxTokens must be an integer from 250 to 2500");
      }
      const root = evidenceRepositoryRoot(pi.cwd);
      const result = await collectFailureEvidence(root, { error: params.error, maxTokens }, undefined, signal);
      return { content: [{ type: "text", text: formatEvidence(result) }], details: result };
    },
  };
};

export default factory;
