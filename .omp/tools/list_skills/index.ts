import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { scanSkills, skillsRoot } from "./skills_lib.js";

const DESCRIPTION = [
  "List installed skills with their one-line descriptions, 20 per call, sorted by name in byte order. The page size is the contract, not a hint. Use find_skills to search by need and read_skill to open one.",
  'Call `{}` for the first page, then `{"offset":20}`; `limit` is 1 to 20 (default 20) and larger values are refused, never widened.',
  "The library is $SKILLS_ROOT, else ~/.agents/skills (the same directory as ~/.agents/available-skills here); a directory counts as a skill only when it holds a readable SKILL.md. A missing root lists as empty.",
  "A negative or non-integer offset or limit is refused. Read-only; no model, no network.",
  "Returns `{skills:[{name,description}],total,next_offset?}`; total counts the whole library, and next_offset appears only when another page exists: pass it as the next offset, do not guess it.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "list_skills",
    label: "List skills",
    description: DESCRIPTION,
    parameters: z.object({
      offset: z.number().nullable().optional().describe("Index of the first skill, 0-based over the name-sorted list. Default 0."),
      limit: z.number().nullable().optional().describe("Skills per call, integer 1 to 20. Default 20."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be an integer of 0 or more");
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer from 1 to 20");
      signal?.throwIfAborted();
      const skills = await scanSkills(skillsRoot(process.env));
      const end = offset + limit;
      const details = {
        skills: skills.slice(offset, end).map(({ name, description }) => ({ name, description })),
        total: skills.length,
        ...(end < skills.length ? { next_offset: end } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
};

export default factory;
