import type { Conventions } from "./conventions.js";
import { designNumbers } from "./design_text.js";
import type { DraftedSource, DraftJob } from "./draft_job.js";
import { draftSource } from "./draft_source.js";
import { editableFile } from "./editable_files.js";
import type { PlannedFile } from "./locate_checks.js";
import { mapLimit, type Model } from "./model.js";
import { draftRegistryEdit, exportLines } from "./registry_draft.js";
import type { Design, FileChange, Finding } from "./schemas.js";

const DRAFT_CONCURRENCY = 4;

export function draftJobOf(design: Design, conventions: Conventions, plan: readonly PlannedFile[]): DraftJob {
  return {
    design,
    conventions,
    plan,
    numbers: designNumbers(design),
    known: new Set(conventions.layout.known_files),
    changeSet: new Set(plan.map((file) => file.path)),
  };
}

const isRegistry = (file: PlannedFile): boolean => file.role === "registry";

const created = (source: DraftedSource): FileChange => ({
  path: source.file.path,
  action: "create",
  role: source.file.role,
  reason: source.file.reason,
  content: source.content,
});

/** Every module, test and doc of the plan drafted, siblings as examples; a file being revised gets its findings. */
export async function draftSources(
  job: DraftJob,
  model: Model,
  revisions: ReadonlyMap<string, { readonly previous: string; readonly findings: readonly Finding[] }> = new Map(),
  only: ReadonlySet<string> | undefined = undefined,
): Promise<DraftedSource[]> {
  const files = job.plan.filter((file) => !isRegistry(file) && (only === undefined || only.has(file.path)));
  return mapLimit(
    files,
    DRAFT_CONCURRENCY,
    async (file) => ({ file, content: await draftSource(job, file, model, revisions.get(file.path)) }),
  );
}

/** A signature of the names the sources export, so a revision that renames one is noticed. */
export const exportSignature = (sources: readonly DraftedSource[]): string =>
  sources.map((source) => `${source.file.path}\n${exportLines(source.content).join("\n")}`).join("\n");

/** The registry files of the plan edited to list the sources: insertions only, with the diff of each. */
export async function draftTouchpoints(
  job: DraftJob,
  sources: readonly DraftedSource[],
  model: Model,
): Promise<FileChange[]> {
  const registries = job.plan.filter(isRegistry);
  return mapLimit(registries, DRAFT_CONCURRENCY, async (file) => {
    const edit = await draftRegistryEdit(job, file, sources.filter((source) => source.file.role === "module"), model);
    const base = editableFile(job.conventions, file.path)!;
    return {
      path: file.path,
      action: "modify" as const,
      role: file.role,
      reason: file.reason,
      content: edit.content,
      diff: edit.diff,
      base_sha256: base.sha256,
    };
  });
}

export const filesOf = (sources: readonly DraftedSource[], touchpoints: readonly FileChange[]): FileChange[] => [
  ...sources.map(created),
  ...touchpoints,
];

/** The sources with the ones named in `toFix` drafted again from their previous text and findings. */
export async function reviseSources(
  job: DraftJob,
  sources: readonly DraftedSource[],
  toFix: ReadonlyMap<string, readonly Finding[]>,
  model: Model,
): Promise<DraftedSource[]> {
  const revisions = new Map(
    sources.filter((source) => toFix.has(source.file.path)).map((source) => [
      source.file.path,
      { previous: source.content, findings: toFix.get(source.file.path)! },
    ]),
  );
  const redrafted = new Map(
    (await draftSources(job, model, revisions, new Set(revisions.keys()))).map((source) => [source.file.path, source]),
  );
  return sources.map((source) => redrafted.get(source.file.path) ?? source);
}
