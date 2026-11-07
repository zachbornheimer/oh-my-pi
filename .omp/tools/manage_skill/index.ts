import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  authoredSkillExists,
  authoredSkillsRoot,
  deleteManagedSkill,
  managedSkillFile,
  managedSkillsRoot,
  MAX_SKILL_BYTES,
  normalizeSkillName,
  sanitizeDescription,
  writeManagedSkill,
} from "./managed.js";

const DESCRIPTION = [
  "Create, update, or delete a managed skill's SKILL.md under the managed skills root: $MANAGED_SKILLS_ROOT, else ~/.agents/managed-skills (never the authored library). This tool WRITES; read skills with read_skill, page them with list_skills, search with find_skills, none of which see managed skills.",
  'Call `{"action":"create","name":"release-notes","description":"Draft release notes from a changelog.","body":"# Release notes\\n..."}`; `update` takes the same fields; `delete` takes only `action` and `name`.',
  "name is trimmed and lowercased, then MUST match `[a-z0-9][a-z0-9-]{0,63}`. description and body are REQUIRED for create and update; the file is frontmatter with exactly the normalized name and the sanitized one-line description (control characters, `<`, `>`, backticks, repeated `~` removed), a blank line, then the trimmed body.",
  "Refused, nothing written, as an error: an unsafe name, an empty description or body, a body that starts with `---` frontmatter, a final file over 64000 UTF-8 bytes, create over an existing managed skill or a name the authored library (~/.agents/skills) already owns, update or delete of a missing skill, any symlinked root, directory or file, a multiply hard-linked file, a path leaving the root.",
  "delete removes the whole skill directory recursively. Returns `{action,name,path,created?}`; path is the written SKILL.md, or the removed directory for delete.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "manage_skill",
    label: "Manage skill",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["create", "update", "delete"]).describe("`create` a new managed skill, `update` an existing one, or `delete` it."),
      name: z.string().describe("Skill name; trimmed and lowercased, then `[a-z0-9][a-z0-9-]{0,63}`."),
      description: z.string().nullable().optional().describe("One-line frontmatter description. Required for create and update."),
      body: z.string().nullable().optional().describe("SKILL.md markdown body without frontmatter. Required for create and update."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const action = params.action;
      const normalized = normalizeSkillName(params.name ?? "");
      if ("error" in normalized) throw new Error(normalized.error);
      const { name } = normalized;
      const root = managedSkillsRoot(process.env);

      if (action === "delete") {
        const deleted = await deleteManagedSkill(root, name);
        if ("error" in deleted) throw new Error(deleted.error);
        const details = { action, name, path: deleted.path };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }

      if (params.description == null || params.body == null) {
        throw new Error(`"${action}" requires both "description" and "body".`);
      }
      const description = sanitizeDescription(params.description);
      if (description === "") throw new Error(`Managed skill "${name}" needs a non-empty description.`);
      const body = params.body.trim();
      if (body === "") throw new Error(`Managed skill "${name}" needs a non-empty body.`);
      if (/^---[ \t]*(?:\r?\n|$)/.test(body)) {
        throw new Error(`Managed skill "${name}" body must not include frontmatter: do not include frontmatter.`);
      }
      if (action === "create" && (await authoredSkillExists(authoredSkillsRoot(process.env), name))) {
        throw new Error(
          `an authored skill named "${name}" already exists in the skills library; managed skills never shadow authored skills`,
        );
      }
      const content = managedSkillFile(name, description, body);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_SKILL_BYTES) throw new Error(`Managed skill is ${bytes} bytes; the limit is ${MAX_SKILL_BYTES}.`);
      const written = await writeManagedSkill(root, name, content, action);
      if ("error" in written) throw new Error(written.error);
      const details = action === "create" ? { action, name, path: written.path, created: true } : { action, name, path: written.path };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
};

export default factory;
