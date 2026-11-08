## Auto-Learn (experimental)

`manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced in future sessions like other skills.

When the turn produced something the next session will need, prefer, in order:

1. An existing workflow or tool already does it, or the underlying code, config, or CLI should be fixed directly so the procedure is unnecessary. Name that workflow or tool; do not write a skill that restates its commands.
2. The steps are deterministic, the inputs are stable, and a check can fail. Create a **workflow + tools** (`mastra-authoring` / `create_workflow` / `derive_workflow` for multi-step pipelines, `creating-new-tools` under `~/.omp/agent/tools` for leaf tools) that owns the sequence, state transitions, validation, evidence, and safe defaults. Agents call the workflow or tool instead of reconstructing the procedure from prose. A skill that lists those commands is the wrong artifact: it is optional, it may not be selected, and the next session still re-derives the steps into context.
3. The part you cannot name before the run (a judgment, a gotcha, which tool to call): a managed skill, via `manage_skill` create | update | delete. Or nothing.

Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly. Prefer enhancing an existing workflow, tool, or managed skill to creating a near-duplicate.
Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly. Prefer enhancing an existing tool or managed skill to creating a near-duplicate.
