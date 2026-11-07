import { guidanceBrief, layoutBrief } from "./conventions_brief.js";
import { designBrief } from "./design_text.js";
import { draftProblems } from "./draft_checks.js";
import { type DraftJob, ownerOf, type Revision } from "./draft_job.js";
import { examplesFor } from "./examples.js";
import type { PlannedFile } from "./locate_checks.js";
import { QUESTIONS } from "./questions.js";
import type { Model } from "./model.js";
import { extensionOf } from "./paths.js";

const FENCE = "```";
const WHOLE_FENCED_BLOCK = /^```([\w-]*)\n([\s\S]*?)\n```$/;
const MARKDOWN_TAGS: readonly string[] = ["", "md", "markdown"];

/** The text inside a reply that is one fenced block, unless the file is markdown and the block is some other language. */
export function unfenced(reply: string, path: string): string {
  const match = WHOLE_FENCED_BLOCK.exec(reply.trim());
  if (match === null) return reply.trim();
  const markdown = extensionOf(path) === ".md";
  return markdown && !MARKDOWN_TAGS.includes(match[1]!) ? reply.trim() : match[2]!;
}

const withFinalNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

function draftBrief(job: DraftJob, file: PlannedFile, revision?: Revision): string {
  const owner = ownerOf(job.plan);
  const examples = examplesFor(file.path, owner, job.conventions.siblings).map((example) =>
    `${example.path}:\n${FENCE}\n${example.text}\n${FENCE}`
  );
  const changeFiles = job.plan.map((planned) => `- ${planned.path} (${planned.role}): ${planned.reason}`);
  const sections = [
    `The design:\n${designBrief(job.design)}`,
    `Files of this change:\n${changeFiles.join("\n")}`,
    layoutBrief(job.conventions),
    guidanceBrief(job.conventions),
    examples.length === 0 ? "" : `Example files from the closest siblings:\n\n${examples.join("\n\n")}`,
    `The file:\n${file.path} (${file.role}): ${file.reason}`,
  ];
  if (revision !== undefined) {
    const findings = revision.findings.map((finding) => `- ${finding.principle}: ${finding.finding}`).join("\n");
    sections.push(
      `Your previous draft:\n${FENCE}\n${revision.previous}\n${FENCE}`,
      `Fix these findings in the rewrite:\n${findings}`,
    );
  }
  return sections.filter((section) => section !== "").join("\n\n");
}

/** The text of one module, test or doc, written like its siblings and refused until it meets the repo's conventions. */
export async function draftSource(
  job: DraftJob,
  file: PlannedFile,
  model: Model,
  revision?: Revision,
): Promise<string> {
  const instructions = QUESTIONS.draft.Source!.instructions;
  const prompt = `## Source\n${instructions}\n\n${draftBrief(job, file, revision)}\n`;
  const scene = { file, known: job.known, changeSet: job.changeSet, numbers: job.numbers };
  return model.text(prompt, (reply) => {
    const content = withFinalNewline(unfenced(reply, file.path));
    const problems = draftProblems(content, scene);
    if (problems.length > 0) throw new Error(problems.join("; "));
    return content;
  });
}
