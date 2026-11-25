<<<<<<< HEAD
Edit by description.
Per file: `# path`, then one `- ` bullet per change, multiple files batch.
- Bullet: site (line #, class/fn identifier nearby, short substr) + op (what to do?)
- Check the returned diffs; resend a failed file, more exact.
=======
Edit existing files by describing the changes. A fast model types each file's patch; the result is the applied diffs.

{{#if xml}}
Payload: one `<edit file="path">` element per file. The lines inside it say what changes in that file; `</edit>` on its own line closes it. Batch every file of a change into one call.
{{else}}
Payload: one section per file. A `# path` line opens it; the lines after it say what changes in that file. Batch every file of a change into one call.
{{/if}}

- Changes: mechanical instructions that someone holding only that file can carry out with no decisions left to make.
- Name every site by its text: the function, the statement, a quoted fragment. Line numbers from your latest read MAY be added.
- New or changed code: give it verbatim. Deleting, moving, swapping: say which lines and where they go.
- NEVER describe a goal ("fix the bug", "handle the error"): decide the fix yourself, then describe the text change.
{{#if xml}}
- NEVER put text outside the elements.
{{else}}
- NEVER start a change line with `#`: it opens the next file.
{{/if}}
- Files apply independently: one that fails stays unchanged and is reported; the others still apply.
- You MUST check the returned diffs. Wrong or not applied? Send that file again with a more exact instruction.
- New files: `write`.
>>>>>>> ffc65e7c4711ef66d4d7c1136867dd4a165a433c

<example>
# src/jobs.ts
- `drain()` > swap `const batch …` and `const lim …`.
- del export `stop(…)`
# src/server.ts
- rep `retrunVal` → `returnVal`.
- ln 88 > del `if OPTIONS` block @ `handle()`
</example>
