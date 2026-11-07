import type { Entry, Kind } from "../schemas.js";
import { SOURCE_RENOVATE_NOTES } from "../schemas.js";
import { Classify } from "./classify.js";
import { StripMarkup } from "./markup.js";

// Port of agentmux internal/changelog/parse.go: release-note markdown into entries.

/** maxEntryRunes bounds one entry's text; a release that lists a hundred PR links on one bullet should not flood the reader. */
const MAX_ENTRY_RUNES = 400;
const ELLIPSIS = "\u2026";

const HEADING_LINE = /^#{1,6}\s+(.*)$/;
const BULLET_LINE = /^(?:[-*+]|\d+\.)\s+(.*)$/;
const SPACE_RUN = /\s+/g;
// boilerplateLine matches release-note furniture that says nothing about the change itself.
const BOILERPLATE_LINE =
  /^(?:\*{0,2}full changelog\*{0,2}\b|compare source|this pr was generated|-{3,}$|.*\bmade their first contribution\b)/i;
// noiseHeading names sections whose own content is furniture.
const NOISE_HEADING = /^(?:new contributors?|contributors?|what'?s changed|changes|changelog|release notes)$/i;
const SKIP_SECTION = /^(?:new )?contributors?$/i;

function headingHint(title: string): Kind {
  return NOISE_HEADING.test(title) ? "other" : Classify(title);
}

function truncate(text: string): string {
  const runes = Array.from(text);
  if (runes.length <= MAX_ENTRY_RUNES) return text;
  return runes.slice(0, MAX_ENTRY_RUNES).join("") + ELLIPSIS;
}

function newEntry(version: string, source: string, text: string, hint: Kind): Entry {
  const collapsed = text.replace(SPACE_RUN, " ");
  let kind = Classify(collapsed);
  if (kind === "other") kind = hint;
  return { version, kind, text: truncate(collapsed), source };
}

function trimEdges(text: string): string {
  return text.replace(/^[*_: ]+/, "").replace(/[*_: ]+$/, "");
}

/**
 * entriesFromBody turns one version's release-note markdown into entries. A heading that names a kind
 * ("Bug Fixes") classifies the lines under it when the line itself says nothing.
 */
export function entriesFromBody(version: string, source: string, body: string): Entry[] {
  const entries: Entry[] = [];
  let hint: Kind = "other";
  let skip = false;
  for (const raw of body.replaceAll("\r\n", "\n").split("\n")) {
    const line = StripMarkup(raw).trim();
    if (line === "") continue;
    const heading = HEADING_LINE.exec(line);
    if (heading !== null) {
      const title = trimEdges(heading[1]!.trim());
      skip = SKIP_SECTION.test(title);
      hint = headingHint(title);
      continue;
    }
    if (skip || BOILERPLATE_LINE.test(line)) continue;
    const bullet = BULLET_LINE.exec(line);
    const text = bullet !== null ? bullet[1]!.trim() : line;
    if (text === "") continue;
    entries.push(newEntry(version, source, text, hint));
  }
  return entries;
}

/** entriesFromNotes wraps pasted changelog lines as entries of one version. */
export function entriesFromNotes(version: string, notes: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const note of notes) {
    const text = StripMarkup(note).trim();
    if (text === "") continue;
    entries.push(newEntry(version, SOURCE_RENOVATE_NOTES, text, "other"));
  }
  return entries;
}
