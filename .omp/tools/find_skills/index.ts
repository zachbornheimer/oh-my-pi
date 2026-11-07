import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { rankSkills, scanSkills, SKILL_FILE, skillsRoot } from "./skills_lib.js";
import { join } from "node:path";

const DESCRIPTION = [
  "Find installed skills by need. Scores every skill's frontmatter description against the need by case-insensitive keyword overlap (IDF-weighted, stopwords dropped, 3+ character prefix matches); no model is called.",
  'Call `{"need":"review a pull request"}`; add `"limit":3` (default 5, 1 to 10). Use list_skills to page the whole library and read_skill to open one.',
  "The library is $SKILLS_ROOT, else ~/.agents/skills (the same directory as ~/.agents/available-skills here); a directory counts as a skill only when it holds a readable SKILL.md.",
  "A blank need or a limit outside 1 to 10 is refused. Read-only; no network.",
  'Returns `{matches:[{name,description,path}]}`, best first, path being the absolute SKILL.md. An empty list means nothing overlapped, not that the search failed.',
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "find_skills",
    label: "Find skills",
    description: DESCRIPTION,
    parameters: z.object({
      need: z.string().describe("What the caller needs, matched by keyword overlap against each skill's description."),
      limit: z.number().nullable().optional().describe("Maximum matches, integer 1 to 10. Default 5."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      const need = params.need?.trim() ?? "";
      if (need === "") throw new Error("need must not be blank");
      const limit = params.limit ?? 5;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("limit must be an integer from 1 to 10");
      signal?.throwIfAborted();
      const skills = await scanSkills(skillsRoot(process.env));
      const matches = rankSkills(skills, need)
        .slice(0, limit)
        .map(({ skill }) => ({ name: skill.name, description: skill.description, path: join(skill.directory, SKILL_FILE) }));
      const details = { matches };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
};

export default factory;
