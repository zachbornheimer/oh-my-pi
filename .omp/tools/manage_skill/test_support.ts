/** Test-only copy of the frontmatter field reader, to prove generated frontmatter reads back. */
export function frontMatterFieldsForTest(text: string): Record<string, string> {
  const lines = text.split("\n");
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return fields;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return fields;
    const c = lines[i]!.indexOf(":");
    if (c < 0) continue;
    let v = lines[i]!.slice(c + 1).trim();
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) v = v.slice(1, -1);
    fields[lines[i]!.slice(0, c).trim()] = v;
  }
  return {};
}
