/** A changed file as GitHub's compare API lists it; `patch` is absent for binary or oversized files. */
export interface ChangedFile {
  readonly filename: string;
  readonly patch?: string;
}

/** Per file, each new-side line GitHub accepts a review comment on, mapped to the hunk it sits in. */
export type CommentableLines = ReadonlyMap<string, ReadonlyMap<number, number>>;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines a review comment may anchor to with `side: RIGHT`: added and context lines inside a hunk.
 * A multi-line comment must start and end in the same hunk, so each line keeps its hunk index.
 */
export function commentableLines(files: readonly ChangedFile[]): CommentableLines {
  const byFile = new Map<string, Map<number, number>>();
  for (const file of files) {
    if (file.patch === undefined) continue;
    const lines = new Map<number, number>();
    let hunk = -1;
    let next = 0;
    for (const text of file.patch.replace(/\n$/, "").split("\n")) {
      const header = HUNK_HEADER.exec(text);
      if (header) {
        hunk += 1;
        next = Number(header[1]);
        continue;
      }
      if (hunk < 0 || text.startsWith("-") || text.startsWith("\\")) continue;
      // "+" is added, " " is context; an empty line is context whose leading space was trimmed.
      lines.set(next, hunk);
      next += 1;
    }
    byFile.set(file.filename, lines);
  }
  return byFile;
}
