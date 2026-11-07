import { additionDiff, applyInsertions } from "./additions.js";
import { editableBrief } from "./conventions_brief.js";
import { designBrief } from "./design_text.js";
import type { DraftedSource, DraftJob } from "./draft_job.js";
import { type EditableFile, editableFile } from "./editable_files.js";
import { DECLARATION_ONLY_STEMS, type PlannedFile } from "./locate_checks.js";
import type { Model } from "./model.js";
import { stemOf } from "./paths.js";
import { parseInsertionsReply } from "./schemas.js";

const EXPORT_LINE = /^export\s.*$/gm;
const MAX_EXPORT_LINE_CHARS = 160;

type Insertions = ReturnType<typeof parseInsertionsReply>;

/** The registry after the new modules are listed in it, and the diff showing nothing else changed. */
export interface RegistryEdit {
  readonly content: string;
  readonly diff: string;
}

/** The `export` lines of a module: the names a registry would list. */
export function exportLines(content: string): string[] {
  return (content.match(EXPORT_LINE) ?? []).map((line) => line.slice(0, MAX_EXPORT_LINE_CHARS));
}

function newModulesBrief(modules: readonly DraftedSource[]): string {
  return modules
    .map(({ file, content }) => `${file.path} exports:\n${exportLines(content).map((line) => `  ${line}`).join("\n")}`)
    .join("\n");
}

function editedRegistry(registry: EditableFile, insertions: Insertions): RegistryEdit {
  const edited = applyInsertions(registry.text, insertions);
  if (edited.problem !== undefined) throw new Error(edited.problem);
  const diff = additionDiff(registry.path, registry.text, edited.text!);
  if (diff === undefined) throw new Error("the edit changed an existing line: insert lines only");
  return { content: edited.text!, diff };
}

/** What the registry file must gain to list the change's modules, as insertions only. */
export async function draftRegistryEdit(
  job: DraftJob,
  file: PlannedFile,
  modules: readonly DraftedSource[],
  model: Model,
): Promise<RegistryEdit> {
  const registry = editableFile(job.conventions, file.path)!;
  const listed = modules.filter(({ file: module }) => !DECLARATION_ONLY_STEMS.includes(stemOf(module.path)));
  const brief = [
    `The design:\n${designBrief(job.design)}`,
    `The registry (${file.path}):\n${editableBrief(registry)}`,
    `The new modules: ${newModulesBrief(listed)}`,
    `Why this registry is edited: ${file.reason}`,
  ].join("\n\n");
  return model.json("registry_edit", "Insertions", brief, parseInsertionsReply, (insertions) =>
    editedRegistry(registry, insertions)
  );
}
