import type { Conventions, Registry } from "./conventions.js";
import { basenameOf } from "./paths.js";

/** Files that list a package's scripts and tasks: a registry only when they list the siblings too. */
export const MANIFEST_FILE_NAMES: ReadonlySet<string> = new Set(["package.json", "mise.toml"]);

/** An existing file the change may add lines to, as the host read it. */
export interface EditableFile {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

function isRegistryOfSiblings(registry: Registry, conventions: Conventions): boolean {
  if (!MANIFEST_FILE_NAMES.has(basenameOf(registry.path))) return true;
  return conventions.siblings.some((sibling) => registry.text.includes(sibling.name));
}

/**
 * The existing files a change may edit, by inserting lines: the registries that list modules (a manifest only when it
 * names the siblings), and the files of the closest siblings (where new code is wired in). A file the host read only
 * in part is not editable.
 */
export function editableFiles(conventions: Conventions): EditableFile[] {
  const registries = conventions.registries.filter((registry) => isRegistryOfSiblings(registry, conventions));
  const candidates = [...registries, ...conventions.siblings.flatMap((sibling) => sibling.files)];
  const seen = new Set<string>();
  return candidates.flatMap((file) => {
    if (file.truncated || file.sha256 === undefined || seen.has(file.path)) return [];
    seen.add(file.path);
    return [{ path: file.path, text: file.text, sha256: file.sha256 }];
  });
}

export const editableFile = (conventions: Conventions, path: string): EditableFile | undefined =>
  editableFiles(conventions).find((file) => file.path === path);
