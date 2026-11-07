import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { resolveSkillFile, skillsRoot } from "./skills_lib.js";

const DESCRIPTION = [
  "Read one installed skill's SKILL.md, or a file inside its directory (`references/`, `scripts/`). Learn the name first with find_skills or list_skills; this reads, never runs or edits (use manage_skill to write a managed skill).",
  'Call `{"name":"code-style"}`, `{"name":"code-style","path":"references/x.md"}` or `{"name":"skill://code-style/references/x.md"}`. `path` defaults to SKILL.md and, when given, wins over a skill:// subpath.',
  "The library is $SKILLS_ROOT, else ~/.agents/skills (the same directory as ~/.agents/available-skills here).",
  "Refused with an error, nothing read: an empty name, `.` or `..` as the name, a path that leaves the skill directory or the library root, a missing skill or file. Symlinks inside a skill directory are followed.",
  "Returns the file text; details carry `{name,path,content}` with the absolute path read. Read-only; no network.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "read_skill",
    label: "Read skill",
    description: DESCRIPTION,
    parameters: z.object({
      name: z.string().describe("Skill name such as `code-style`, optionally `skill://<name>` or `skill://<name>/<subpath>`."),
      path: z.string().nullable().optional().describe("File inside the skill directory, such as `references/x.md`. Default SKILL.md."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const path = params.path?.trim() ? params.path : undefined;
      const resolved = await resolveSkillFile(skillsRoot(process.env), params.name ?? "", path);
      if ("error" in resolved) throw new Error(resolved.error);
      return { content: [{ type: "text", text: resolved.content }], details: resolved };
    },
  };
};

export default factory;
