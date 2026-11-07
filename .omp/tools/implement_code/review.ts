import type { Conventions } from "./conventions.js";
import { layoutBrief } from "./conventions_brief.js";
import { designBrief } from "./design_text.js";
import type { Model } from "./model.js";
import { type Design, type FileChange, type Finding, parseFindingsReply } from "./schemas.js";

/** A finding this sure is worth one more draft of its file. */
export const REVISION_CONFIDENCE = 0.7;
/** Most characters of the change shown to the reviewer; the rest is left out with a note. */
const MAX_REVIEWED_CHARS = 60000;
const FENCE = "```";

function changeText(files: readonly FileChange[]): string {
  let remaining = MAX_REVIEWED_CHARS;
  const parts: string[] = [];
  for (const file of files) {
    const shown = file.diff ?? file.content;
    if (shown.length > remaining) {
      parts.push(`${file.path}: left out, the review has no room for it`);
      continue;
    }
    remaining -= shown.length;
    parts.push(`${file.path} (${file.role}, ${file.action}):\n${FENCE}\n${shown}\n${FENCE}`);
  }
  return parts.join("\n\n");
}

/** A self-review of the drafted change against SRP, DRY, SOLID and the repo's conventions. */
export async function reviewChange(
  design: Design,
  conventions: Conventions,
  files: readonly FileChange[],
  model: Model,
): Promise<Finding[]> {
  const paths = new Set(files.map((file) => file.path));
  const brief = [`The design:\n${designBrief(design)}`, layoutBrief(conventions), `The change:\n${changeText(files)}`]
    .join("\n\n");
  return model.json("review", "Findings", brief, parseFindingsReply, (findings) => {
    const stray = findings.find((finding) => finding.file !== "" && !paths.has(finding.file));
    if (stray !== undefined) {
      throw new Error(`"${stray.file}" is not a file of this change; name one of: ${[...paths].join(", ")}`);
    }
    return findings;
  });
}

/** The findings sure enough, and about a file that can be drafted again (not a registry edit), grouped by file. */
export function findingsToFix(findings: readonly Finding[], files: readonly FileChange[]): Map<string, Finding[]> {
  const draftable = new Set(files.filter((file) => file.role !== "registry").map((file) => file.path));
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.confidence < REVISION_CONFIDENCE || !draftable.has(finding.file)) continue;
    grouped.set(finding.file, [...(grouped.get(finding.file) ?? []), finding]);
  }
  return grouped;
}
