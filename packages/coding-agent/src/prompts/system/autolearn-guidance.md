## Auto-Learn (experimental)

`autolearn_manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced in future sessions like other skills.

When the turn produced something the next session will need, prefer, in order:

1. An existing tool already does it. Name that tool. Do not write a skill that restates its commands.
2. The steps are deterministic, the inputs are stable, and a check can fail. Create a tool that owns the sequence, the validation, the evidence, and the safe defaults. Agents call the tool. They do not reconstruct the procedure from prose. A skill that lists those commands is the wrong artifact: it is optional, it may not be selected, and the next session still re-derives the steps into context. Load `creating-new-tools` and write the tool under `~/.omp/agent/tools`.
3. The part you cannot name before the run (a judgment, a gotcha, which tool to call): a managed skill, via `autolearn_manage_skill` create | update | delete. Or nothing.

Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly. Prefer enhancing an existing tool or managed skill to creating a near-duplicate.
