import type { Conventions } from "./conventions.js";
import { guidanceBrief, layoutBrief } from "./conventions_brief.js";
import { designBrief } from "./design_text.js";
import { locateProblems, type PlannedFile } from "./locate_checks.js";
import type { Model } from "./model.js";
import { type Design, parseLocateReply } from "./schemas.js";

/** The files the design needs, placed where the repo's siblings are, refused until the set meets the repo's rules. */
export async function locateFiles(design: Design, conventions: Conventions, model: Model): Promise<PlannedFile[]> {
  const brief = [designBrief(design), layoutBrief(conventions), guidanceBrief(conventions)].filter((part) =>
    part !== ""
  ).join("\n\n");
  return model.json("locate", "Files", brief, parseLocateReply, (files) => {
    const problems = locateProblems(files, conventions);
    if (problems.length > 0) throw new Error(problems.join("; "));
    return files;
  });
}
