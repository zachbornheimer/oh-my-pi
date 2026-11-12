Automated capture turn — not a user reply; user has not responded to your previous turn. Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action; only the user can do so.

If your previous turn produced reusable output, capture it now only if it will genuinely help next time:

- **Information or short-term bridge** (domain facts, architecture, gotchas, which tool to call, or a short-term workaround needed until `optimize_tooling` / `relay` lands a tool) → managed skill (`autolearn_manage_skill`).
- **Set of actions** (a repeatable sequence of commands, checks, or steps with stable inputs) → its long-term home is a **workflow + tools** (`mastra-authoring` / `create_workflow` / `derive_workflow`, or `creating-new-tools` under `~/.omp/agent/tools`); when a short-term skill bridges the gap for the next session, state the action boundary clearly so `optimize_tooling` / `relay` can promote it to a tool and retire the skill.
- **Durable fact, convention, or user preference** → remember with `autolearn_learn` when memory enabled.
If nothing worth keeping, do nothing.

Creating or updating that artifact is the capture. Then stop. Do not resume prior work, answer pending questions, commit the user's work, or produce a continuation reply. Yield; wait for the user's next prompt.
