import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { skillRoots } from "./skills.js";
import { runSuggest } from "./suggest.js";

const DESCRIPTION = [
  "Suggest which installed skill, tool or MCP tool a prompt should use, each judged by a model on its own and kept only at 0.6 confidence or more (best 5 per kind). It does not run or load anything it suggests.",
  "Use `select_model` to pick a model route and `task_class` for the kind of work.",
  'Call `{"text":"how does the cache work","Catalog":[{"Kind":"tool","Name":"grep","Description":"Search file contents","HowToCall":"grep({pattern})"}]}`.',
  "Installed skills are read from disk (`SKILL.md` frontmatter under `.omp/skills`, `.agents/skills`, `.claude/skills` in the working directory and its parents, then `~/.omp/agent/skills`, `~/.agents/skills`, `~/.claude/skills`); a hidden, disabled or model-invocation-disabled skill is skipped. This tool cannot list the session's tools: pass tools and MCP tools in `Catalog` (entries `{Kind: skill|tool|mcp_tool, Name, Description?, HowToCall?, Harness?, Server?, Path?}`, the MCP tool file shape, or `{skills, tools, mcp_tools}`) or `CatalogJson` (same, as a string); do not invent entries.",
  "Optional context: `FullPrompt`, `InFlight`, `RecentTurns`; `Harness` keeps entries with an empty or matching harness; `InstalledSkills:false` judges only the catalog you pass; `SkillRoots` adds skill directories.",
  "Blank text is refused (`suggest_skills_tools_and_mcp requires a prompt`). Costs one model run (`omp -p`, no tools) per 80 candidates of a kind, 4 at once. A failed request is a note; `Degraded` is true only when nothing could be judged. Confidence is the model's stated probability, not TypeSafe Jev's calibrated one.",
  "Returns `{Suggestions:[{Kind,Name,Path,Description,HowToCall,Confidence}], Reason, Degraded, Notes, Scores, Ranking}`; open a skill with `read skill://<Name>`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const optionalString = (description: string) => z.string().nullable().optional().describe(description);
  return {
    name: "suggest_skills_tools_and_mcp",
    label: "Suggest skills, tools and MCP",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The prompt to pick skills, tools and MCP tools for. Must not be blank."),
      FullPrompt: optionalString("The whole prompt when `text` is only one part of it. Default: empty."),
      InFlight: optionalString("Work already in flight, as context for the judge (first 600 characters used). Default: empty."),
      RecentTurns: z.array(z.string()).nullable().optional().describe("Recent conversation turns, as context for the judge. Default: none."),
      Harness: optionalString("Harness name; keeps catalog entries with an empty or matching Harness. Default: empty keeps all."),
      Catalog: z
        .array(z.any())
        .nullable()
        .optional()
        .describe("Extra candidates to judge, mainly tools and MCP tools: entries `{Kind, Name, Description?, HowToCall?, Harness?}` or the MCP tool file's entries `{name, description, kind?}`. Default: none."),
      CatalogJson: optionalString("The same candidates as a JSON string (array, MCP tool file shape, or `{skills, tools, mcp_tools}`). Default: empty."),
      InstalledSkills: z.boolean().nullable().optional().describe("Judge the installed skills too. Default: true."),
      SkillRoots: z.array(z.string()).nullable().optional().describe("Extra skill directories (`<dir>/<name>/SKILL.md`), scanned before the standard ones; relative to the working directory. Default: none."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const roots = skillRoots({ cwd: pi.cwd, extra: params.SkillRoots ?? [] });
      const output = await withHeartbeat(onUpdate, "suggest_skills_tools_and_mcp is working", () =>
        runSuggest(params, { step: ompModelStep(pi.exec), signal, skillRoots: roots }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
