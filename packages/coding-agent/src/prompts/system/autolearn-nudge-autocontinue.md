Automated capture turn — not a user reply; user has not responded to your previous turn. Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action; only the user can do so.

If your previous turn produced reusable output, capture it now only if it will genuinely help next time:

- Deterministic procedure with stable inputs and a checkable result → create the tool (`creating-new-tools`, under `~/.omp/agent/tools`). Do not write a skill that restates the commands. The tool owns the sequence so the next session calls it instead of re-deriving the steps into context.
- Judgment or a gotcha that cannot be named before the run → managed skill (`manage_skill`).
- Durable fact, convention, or user preference → remember with `learn` when memory enabled.
If nothing worth keeping, do nothing.

Creating that tool or skill is the capture. Then stop. Do not resume prior work, answer pending questions, commit the user's work, or produce a continuation reply. Yield; wait for the user's next prompt.
