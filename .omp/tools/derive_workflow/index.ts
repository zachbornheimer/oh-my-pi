import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { applyWorkflow } from "./apply.ts";
import { deriveWorkflow } from "./derive.ts";
import { ompModelStep, withHeartbeat } from "./omp_model.ts";
import { readSource } from "./reader.ts";

const DESCRIPTION = [
  "Derive the repeatable process from a finished conversation or a script, SKILL.md or runbook as a workflow definition (steps, inputs, rules, checks, SKILL.md text); use it to turn one successful run into a reusable skill.",
  'Input `{"source":"claude:<session id>"}` (`<harness>:<id>`: claude, codex or grok; id is a full id, its start or `latest`) or `{"source":"~/.agents/available-skills/webmaster/SKILL.md"}` (`~/`, absolute or cwd-relative path).',
  "Optional `name` (lower-case words joined by hyphens) wins over the model's; `from_turn`/`to_turn` (1-based, inclusive) bound a transcript's turns or a document's lines; `apply` defaults to false.",
  "Code extracts candidates (shell commands, file edits, numbered lines, code blocks), drops reads, failed and retried runs, parameterizes hosts, ids and home paths, and requires every `run` to appear in the source.",
  "Spawned `omp -p` model runs (no tools) classify each candidate as command, judgment, approval or edit, write a check per non-approval step, summarize, and outline a document with no list; the model states these answers, not calibrated probabilities.",
  "No candidates, over 120 candidates, a bad `name`, or every candidate judged incidental throws: bound the source with `from_turn`/`to_turn`. omp, pi, cursor, copilot, hermes, opencode and agentmux transcripts are refused (no tool calls read).",
  "It never runs a step. It writes nothing unless `apply` is true: then `skill_markdown` goes ONLY to ~/.agents/available-skills/<name>/SKILL.md, never overwriting.",
  "Returns `{name, description, trigger, inputs, steps[{key,title,kind,run?,needs?,requires,check?,on_failure,evidence}], rules, outputs, literals, skill_markdown, source{counts}, warnings?, applied?{path,outcome:written|exists}}`.",
  "Review the SKILL.md before installing; for an omp tool follow the `creating-new-tools` skill. `get_recent_turns` reads a conversation as text.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "derive_workflow",
    label: "Derive workflow",
    description: DESCRIPTION,
    parameters: z.object({
      source: z.string().describe("`<harness>:<id>` (claude, codex or grok) or the path of a script, SKILL.md or runbook."),
      name: z.string().nullable().optional().describe("Skill name: lower-case words joined by hyphens, such as `new-site`. Default: the model\'s."),
      from_turn: z.number().int().positive().nullable().optional().describe("First turn (transcript) or line (document) to read, from 1, included."),
      to_turn: z.number().int().positive().nullable().optional().describe("Last turn (transcript) or line (document) to read, from 1, included."),
      apply: z.boolean().nullable().optional().describe("Write skill_markdown to ~/.agents/available-skills/<name>/SKILL.md, never overwriting. Default false."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const home = homedir();
      const output = await withHeartbeat(onUpdate, "derive_workflow is reading and asking the model", async () => {
        const read = await readSource(
          {
            source: params.source,
            name: params.name ?? undefined,
            from_turn: params.from_turn ?? undefined,
            to_turn: params.to_turn ?? undefined,
          },
          { home, cwd: pi.cwd },
        );
        const derived = await deriveWorkflow(read, { step: ompModelStep(pi.exec), signal });
        return params.apply === true ? applyWorkflow(derived, home) : derived;
      });
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], details: output };
    },
  };
};

export default factory;
