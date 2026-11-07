import type { Excerpt, Sibling } from "./conventions.js";
import { basenameOf, extensionOf, isTestPath } from "./paths.js";

/** Most characters of sibling files shown with one draft. */
const MAX_EXAMPLE_CHARS = 14000;
const MAX_EXAMPLES = 3;
const MAX_SUPPORT_EXAMPLES = 2;
const SAME_ROLE_NAME = 3;
const SAME_EXTENSION = 1;

/** A file's name with the name of the thing it belongs to taken out: `derive_workflow.test.ts` -> `<name>.test.ts`. */
function roleName(path: string, owner: string): string {
  return owner === "" ? basenameOf(path) : basenameOf(path).replaceAll(owner, "<name>");
}

/** The sibling files most like `path`: the same role in the same language, the closest siblings first. */
export function examplesFor(path: string, owner: string, siblings: readonly Sibling[]): Excerpt[] {
  const wanted = roleName(path, owner);
  const scored = siblings.flatMap((sibling, order) =>
    [...sibling.files, ...sibling.tests].map((file) => ({
      file,
      score: (roleName(file.path, sibling.name) === wanted ? SAME_ROLE_NAME : 0)
        + (extensionOf(file.path) === extensionOf(path) ? SAME_EXTENSION : 0),
      order,
    }))
  );
  const ranked = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen: Excerpt[] = [];
  let characters = 0;
  for (const { file } of ranked) {
    if (chosen.length === MAX_EXAMPLES || characters + file.text.length > MAX_EXAMPLE_CHARS) continue;
    chosen.push(file);
    characters += file.text.length;
  }
  return isTestPath(path) ? [...chosen, ...supportFor(siblings, chosen)] : chosen;
}

/** The helpers the sibling tests import, which a new test must call the way they do. */
function supportFor(siblings: readonly Sibling[], chosen: readonly Excerpt[]): Excerpt[] {
  const shown = new Set(chosen.map((file) => file.path));
  const support = siblings.flatMap((sibling) => sibling.support).filter((file) => !shown.has(file.path));
  return [...new Map(support.map((file) => [file.path, file])).values()].slice(0, MAX_SUPPORT_EXAMPLES);
}
