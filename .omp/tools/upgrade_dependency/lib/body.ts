import { StripMarkup } from "./changelog/markup.js";
import type { Package } from "./schemas.js";

// Go internal/depupgrade/body.go: what a Renovate (or similar) PR says it bumps, read from its body and title.

/** One row of the Renovate bump table: `| [name](…) | [`from` → `to`](…) | …`. */
const TABLE_BUMP = /^\s*\|\s*(@?[\w./-]+)\s*(?:\([^|)]*\))?\s*\|(?:[^|\n]*\s)?v?([\w.-]+)\s*(?:→|->)\s*v?([\w.-]+)/gm;
/** A bare `name from → to` line, for a body that carries no table. */
const LINE_BUMP = /^\s*(@?[\w./-]+)\s+v?([\w.-]+)\s*(?:→|->)\s*v?([\w.-]+)/gm;
/** A conventional deps title: `update [dependency] <name> [from <from>] to <to>`. */
const TITLE_BUMP = /(?:update(?: (?:dependency|module|package))?|bump)\s+(@?[\w./-]+)(?:\s+from\s+v?([\w.-]+))?\s+to\s+v?([\w.-]+)/i;

const RELEASE_NOTES_HEADINGS = ["### Release Notes", "## Release Notes"];
const RELEASE_NOTES_STOPS = ["\n### Configuration", "\nThis PR was generated"];

function version(value: string): string {
  return value.replace(/^v/, "");
}

/** Reads version bumps from a Renovate (or similar) PR body. */
export function PackagesFromBody(body: string): Package[] {
  const plain = StripMarkup(body);
  const out: Package[] = [];
  const seen = new Set<string>();
  const add = (name: string, from: string, to: string): void => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === "Package" || trimmed.startsWith("-") || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ name: trimmed, from: version(from), to: version(to) });
  };
  for (const row of plain.matchAll(TABLE_BUMP)) add(row[1] ?? "", row[2] ?? "", row[3] ?? "");
  if (out.length > 0) return out;
  for (const line of plain.matchAll(LINE_BUMP)) add(line[1] ?? "", line[2] ?? "", line[3] ?? "");
  return out;
}

/** Reads a single bump from a conventional deps title. */
export function PackagesFromTitle(title: string): Package[] {
  const match = TITLE_BUMP.exec(StripMarkup(title));
  if (match === null) return [];
  return [{ name: match[1] ?? "", from: version(match[2] ?? ""), to: version(match[3] ?? "") }];
}

/** The body from the Release Notes heading to the first section after it. */
function releaseNotes(body: string): string {
  const heading = RELEASE_NOTES_HEADINGS.find((candidate) => body.includes(candidate));
  if (heading === undefined) return "";
  const rest = body.slice(body.indexOf(heading));
  const newline = rest.indexOf("\n");
  let section = newline < 0 ? rest : rest.slice(newline + 1);
  for (const stop of RELEASE_NOTES_STOPS) {
    const cut = section.indexOf(stop);
    if (cut >= 0) section = section.slice(0, cut);
  }
  return section;
}

/** The release-note furniture that says nothing about the change. */
function skipNote(line: string): boolean {
  const lower = line.toLowerCase();
  return line === "---"
    || line.startsWith("This PR was generated")
    || line.startsWith("Compare Source")
    || line.startsWith("Full Changelog")
    || lower.includes("first contribution")
    || lower === "changes"
    || lower === "what's changed"
    || lower === "new contributors";
}

/** Returns changelog lines from a Release Notes section, bullet and furniture removed. */
export function NotesFromBody(body: string): string[] {
  const section = releaseNotes(body);
  if (section === "") return [];
  const notes: string[] = [];
  for (const raw of StripMarkup(section).split("\n")) {
    const line = raw.trim().replace(/^[-*]+/, "").trim();
    if (line === "" || skipNote(line)) continue;
    notes.push(line);
  }
  return notes;
}
