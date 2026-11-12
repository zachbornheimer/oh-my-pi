Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.

Use: a judgment or gotcha the next session must remember. A deterministic procedure with stable inputs and a checkable result belongs in a tool under `~/.omp/agent/tools`, not here.
User-authored skills separate; tool NEVER edits them.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
