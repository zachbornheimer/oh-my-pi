## Auto-Learn (experimental)

`autolearn_manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced in future sessions like other skills.

When the turn produced something the next session will need, route by shape:

1. **Existing owner or root fix:** If an existing workflow or tool already does it, or the underlying code, config, or CLI should be fixed directly, name or fix that owner instead of writing a skill that restates its commands.
2. **When it is a set of actions (long-term → workflow or tool):** A repeatable sequence of commands, checks, state transitions, or steps with stable inputs belongs in a **workflow + tools** (`mastra-authoring` / `create_workflow` / `derive_workflow` for multi-step pipelines, `creating-new-tools` under `~/.omp/agent/tools` for leaf tools) so code enforces the sequence, validation, evidence, and safe defaults.
3. **When it is information, or a short-term bridge before a tool lands (→ managed skill):** Domain facts, architecture, non-obvious gotchas, which tool to call, or a short-term workaround needed immediately before `optimize_tooling` / `relay` lands the tool belongs in a managed skill via `autolearn_manage_skill` create | update | delete (which `optimize_tooling` later promotes into a tool or retires).

Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly. Prefer enhancing an existing workflow, tool, or managed skill to creating a near-duplicate.
