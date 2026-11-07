import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompResearchStep } from "./omp_research.js";
import { researchOneIssue, type ResearchInput } from "./run.js";
import { CACHE_KEY_PATTERN, type ResearchOutput, SOURCE_KINDS, type SourceKind } from "./schemas.js";
import { checkedHttpUrl } from "./source.js";
import { researchRoot } from "./store.js";

const HEARTBEAT_MS = 15_000;

export const DESCRIPTION =
  "Research what the correct approach to one problem should be, and keep the answer. Reads one source (an `atask` task id, a Linear ticket `ZYS-123`/`SAH-123`, an Opik Diagnostics issue, or any http(s) page), then runs one `omp -p` turn limited to `read` and `web_search` that searches current vendor documentation. Use it before deciding how to fix a class of problem; to change anything, use another tool, because this one changes nothing but its own store. "
  + "Input `{\"source\":{\"kind\":\"linear\",\"ref\":\"ZYS-123\"},\"fresh\":false,\"role\":\"slow\",\"cache_key\":\"my-key\"}`. `kind` is atask, linear, opik or url. An Opik `ref` is `<project id>/<issue id>`, a Diagnostics URL or an `opik://projects/<id>/agent-insights-issues/<id>` URI. `fresh` (default false) researches again instead of reading the store; `role` picks the omp model role; `cache_key` (letters, digits, `_`, `-`) reuses a record even when the source changed. "
  + "Records are cached by source id, source version and question version, so an unchanged source is free and an unchanged re-run costs no model quota; a fresh run spends one model turn and takes minutes. "
  + "Needs `atask` on PATH for atask sources, `LINEAR_API_KEY_ZYS`/`LINEAR_API_KEY_SAH` (or `LINEAR_API_KEY`) for Linear, `OPIK_API_KEY` (or the gateway Keychain entry) for Opik. Writes only `~/.local/state/capability-replicas/research` (or `RESEARCH_STORE_DIR`). Sends progress updates. "
  + "Returns the record `{key,item,assessment,recommendation,approaches,what_would_flip_it,citations,researched_at}`, `from_cache` and `store_path`.";

export function summarize(output: ResearchOutput): string {
  const { record } = output;
  const lines = [
    `${output.from_cache ? "cached" : "researched"}: ${record.item.kind} ${record.item.id} — ${record.item.title}`,
    `key ${record.key}, stored at ${output.store_path}`,
    "",
    `Assessment: ${record.assessment}`,
    "",
    `Recommendation: ${record.recommendation}`,
    "",
    `What would flip it: ${record.what_would_flip_it}`,
  ];
  for (const approach of record.approaches) lines.push(`- [${approach.kind}] ${approach.name}: wins when ${approach.wins_when}; loses when ${approach.loses_when}`);
  for (const citation of record.citations) lines.push(`cite ${citation.title} (${citation.date}) ${citation.url}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "research_one_issue",
  label: "Research one issue",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    source: pi.zod.object({
      kind: pi.zod.enum(SOURCE_KINDS).describe("atask: a task id; linear: TEAM-123; opik: a Diagnostics URL or `<project id>/<issue id>`; url: any http(s) page"),
      ref: pi.zod.string().min(1).describe("The identifier or link for that kind"),
    }),
    cache_key: pi.zod.string().regex(CACHE_KEY_PATTERN, "letters, digits, _ and - only").nullable().optional().describe("A key whose research is reused even when the source changed. Omit to key on content."),
    fresh: pi.zod.boolean().nullable().optional().describe("Research again instead of reading the store. Default false."),
    role: pi.zod.string().nullable().optional().describe("The omp model role for the research turn, such as `slow`. Omit for omp's default model."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `research_one_issue: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const input: ResearchInput = {
        source: { kind: params.source.kind as SourceKind, ref: params.source.ref },
        ...(params.cache_key == null ? {} : { cache_key: params.cache_key }),
        ...(params.fresh == null ? {} : { fresh: params.fresh }),
        ...(params.role == null ? {} : { role: params.role }),
      };
      const output = await researchOneIssue(
        {
          // Every outbound read (Linear, Opik, a page) is parsed and checked once, and fetch is handed the `URL`.
          source: { exec: pi.exec, fetch: (url, init) => fetch(new URL(checkedHttpUrl(url)), init), env: process.env, signal, cwd: pi.cwd },
          ask: ompResearchStep(pi.exec),
          root: researchRoot(),
          now: () => new Date(),
          progress: (message) => {
            phase = message;
          },
        },
        input,
      );
      return {
        content: [{ type: "text", text: summarize(output) }],
        details: { ...output, seconds: Math.round((Date.now() - began) / 1000) },
      };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
