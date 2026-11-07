import type { Conventions } from "./conventions.js";
import { type EditableFile, editableFiles } from "./editable_files.js";

const FENCE = "```";

const fenced = (excerpt: { readonly path: string; readonly text: string; readonly truncated: boolean }): string =>
  `${excerpt.path}${excerpt.truncated ? " (cut)" : ""}:\n${FENCE}\n${excerpt.text}\n${FENCE}`;

const listing = (heading: string, lines: readonly string[]): string =>
  lines.length === 0 ? `${heading}: none` : `${heading}:\n${lines.map((line) => `- ${line}`).join("\n")}`;

/** Where things live and what the repo calls them: the part of the brief that decides file locations. */
export function layoutBrief(conventions: Conventions): string {
  const { layout, style, siblings } = conventions;
  const siblingLines = siblings.map((sibling) => {
    const files = sibling.files.map((file) => file.path).join(", ");
    const tests = sibling.tests.map((test) => test.path).join(", ") || "none found";
    return `${sibling.name}: files ${files}; tests ${tests}`;
  });
  const tests = style.test_layout === "separate_tree"
    ? `in a separate tree under ${style.test_root}/`
    : style.test_layout === "beside_code"
    ? "beside the code they test"
    : "no clear layout";
  return [
    `Language: ${conventions.language}`,
    `File naming: ${conventions.style.naming}; named exports only: ${style.named_exports_only ? "yes" : "no"}`,
    `Tests live ${tests}`,
    listing("Top level of the repo", layout.top_level),
    `Most likely home of the design: ${layout.home || "unclear"}`,
    listing(`Entries of ${layout.home || "the home"}`, layout.home_entries),
    ...layout.near.map((near) => listing(`Entries of ${near.directory}`, near.entries)),
    listing("Closest siblings", siblingLines),
    listing(
      "Existing files you may edit by inserting lines (role registry): registries that list the siblings, and sibling files",
      editableFiles(conventions).map((file) => file.path),
    ),
  ].join("\n");
}

/** The repo's own statements of its conventions and its formatter and linter config. */
export function guidanceBrief(conventions: Conventions): string {
  const sections = [...conventions.guidance, ...conventions.style.config].map(fenced);
  return sections.length === 0 ? "" : `Conventions the repo states:\n${sections.join("\n\n")}`;
}

export const editableBrief = (file: EditableFile): string => fenced({ ...file, truncated: false });
