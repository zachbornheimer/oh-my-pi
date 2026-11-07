import type { Evidence, StepKind, Workflow } from "./schemas.ts";

/** A workflow before its SKILL.md exists. */
export type WorkflowRecord = Omit<Workflow, "skill_markdown" | "applied">;

const FENCE = "```";
const STEP_INDENT = "   ";
const MARKED_KINDS: ReadonlySet<StepKind> = new Set(["judgment", "approval", "edit"]);
/** `1. **Title** `key` (judgment)`: the line `parseSkillSteps` reads back. */
const STEP_LINE = /^\d+\. \*\*.+\*\* `([a-z][a-z0-9_]*)`(?: \((judgment|approval|edit)\))?$/;
const FENCE_OPEN = /^ {3}```\w*$/;
const FENCE_CLOSE = /^ {3}```$/;

const evidenceText = (evidence: Evidence): string =>
  "line" in evidence ? `line ${evidence.line}` : `turn ${evidence.turn_id} (call ${evidence.call_id})`;

function frontmatter(workflow: WorkflowRecord): string[] {
  const hint = workflow.trigger.argument_hint;
  return [
    "---",
    `name: ${workflow.name}`,
    `description: ${JSON.stringify(workflow.description)}`,
    "user-invokable: true",
    ...(hint === undefined || hint === "" ? [] : [`argument-hint: ${JSON.stringify(hint)}`]),
    "---",
  ];
}

function usage(workflow: WorkflowRecord): string[] {
  const inputs = workflow.inputs.map((input) => {
    const example = input.example === undefined ? "" : ` (for example \`${input.example}\`)`;
    return `- \`{${input.name}}\`: ${input.description}${example}`;
  });
  return ["## Usage", "", `\`${workflow.trigger.usage}\``, ...(inputs.length === 0 ? [] : ["", ...inputs])];
}

function stepLines(workflow: WorkflowRecord): string[] {
  return workflow.steps.flatMap((step, index) => {
    const marker = MARKED_KINDS.has(step.kind) ? ` (${step.kind})` : "";
    const lines = [`${index + 1}. **${step.title}** \`${step.key}\`${marker}`];
    if (step.run !== undefined) {
      lines.push(
        `${STEP_INDENT}${FENCE}sh`,
        ...step.run.split("\n").map((line) => `${STEP_INDENT}${line}`),
        `${STEP_INDENT}${FENCE}`,
      );
    }
    if (step.requires.length > 0) {
      lines.push(`${STEP_INDENT}Requires: ${step.requires.map((key) => `\`${key}\``).join(", ")}.`);
    }
    lines.push(`${STEP_INDENT}On failure: ${step.on_failure.replace("_", " ")}.`);
    return lines;
  });
}

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ["", `## ${heading}`, "", ...lines];
}

/**
 * The SKILL.md of a workflow, a pure function of the record: frontmatter, usage, rules, numbered steps with a command in a
 * fence and a marker for each judgment, approval or edit, then checks, outputs and where it came from.
 */
export function renderSkill(workflow: WorkflowRecord): string {
  const checks = workflow.steps.filter((step) => step.check !== undefined).map((step) =>
    `- \`${step.key}\`: \`${step.check}\``
  );
  const outputs = workflow.outputs.map((output) => `- **${output.name}**: ${output.where}`);
  const provenance = [
    `- Source: \`${workflow.source.ref ?? workflow.source.path ?? "unknown"}\``,
    `- Steps kept ${workflow.source.candidates_kept} of ${workflow.source.candidates_seen} candidates; dropped ${workflow.source.dropped.reads} reads, ${workflow.source.dropped.retries} retries, ${workflow.source.dropped.failed} failed attempts, ${workflow.source.dropped.incidental} incidental.`,
    ...workflow.steps.map((step) => `- \`${step.key}\`: ${step.evidence.map(evidenceText).join(", ")}`),
  ];
  return [
    ...frontmatter(workflow),
    "",
    `# ${workflow.name}`,
    "",
    ...usage(workflow),
    ...section("Rules", workflow.rules.map((rule, index) => `${index + 1}. ${rule}`)),
    ...section("Steps", stepLines(workflow)),
    ...section("Checks", checks),
    ...section("Outputs", outputs),
    ...section("Provenance", provenance),
    "",
  ].join("\n");
}

/** What a rendered SKILL.md says about one step; enough to check that rendering lost none. */
export interface RenderedStep {
  readonly key: string;
  readonly kind: StepKind;
  readonly run?: string;
}

/** The steps listed in a SKILL.md that `renderSkill` wrote, in order. */
export function parseSkillSteps(markdown: string): RenderedStep[] {
  const lines = markdown.split("\n");
  const steps: RenderedStep[] = [];
  lines.forEach((line, index) => {
    const found = STEP_LINE.exec(line);
    if (found === null) return;
    const key = found[1]!;
    const marked = found[2] as StepKind | undefined;
    if (marked !== undefined) return void steps.push({ key, kind: marked });
    const body: string[] = [];
    if (FENCE_OPEN.test(lines[index + 1] ?? "")) {
      for (let at = index + 2; at < lines.length && !FENCE_CLOSE.test(lines[at]!); at += 1) {
        body.push(lines[at]!.slice(STEP_INDENT.length));
      }
    }
    steps.push({ key, kind: "command", run: body.join("\n") });
  });
  return steps;
}
