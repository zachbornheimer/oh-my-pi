import type { Excerpt } from "../conventions.js";
import { basenameOf } from "../paths.js";
import type { HostMachine } from "../machine.js";
import { chainOf } from "./directories.js";
import { MAX_GUIDANCE_CHARS, MAX_GUIDANCE_FILES } from "./limits.js";

/** Files agents and people write their conventions in, most binding first. */
const GUIDANCE_NAMES = ["AGENTS.md", "CLAUDE.md", "README.md"];
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const CONVENTION_HEADING =
  /convention|style|guideline|standard|layout|structure|naming|testing|\btests?\b|rule|architecture|contribut|steps to add/i;
const SECTION_START = /^(?=#{1,4}\s)/m;
const INCLUDE_ONLY = /^\s*@\S+\s*$/;
const MIN_USEFUL_CHARS = 80;

/** The sections of a markdown file whose heading talks about conventions, joined; empty when none does. */
export function conventionSections(markdown: string): string {
  const chunks = markdown.split(SECTION_START);
  return chunks.filter((chunk) => CONVENTION_HEADING.test(chunk.split("\n")[0] ?? "")).join("\n").trim();
}

function usefulText(name: string, markdown: string): string {
  if (markdown.trim().length < MIN_USEFUL_CHARS || INCLUDE_ONLY.test(markdown)) return "";
  const sections = conventionSections(markdown);
  if (sections !== "") return sections;
  return INSTRUCTION_FILES.has(name) ? markdown.trim() : "";
}

/** The conventions the repo writes down: the guidance files from each home directory up to the root, nearest first. */
export async function readGuidance(
  machine: HostMachine,
  repo: string,
  paths: readonly string[],
  homes: readonly string[],
): Promise<Excerpt[]> {
  const known = new Set(paths);
  const directories = [...new Set(homes.flatMap(chainOf))];
  const candidates = directories.flatMap((directory) =>
    GUIDANCE_NAMES.map((name) => (directory === "" ? name : `${directory}/${name}`)).filter((path) => known.has(path))
  );
  const found: Excerpt[] = [];
  for (const path of candidates) {
    if (found.length === MAX_GUIDANCE_FILES) break;
    const markdown = await machine.readTextFile(`${repo}/${path}`);
    const text = markdown === undefined ? "" : usefulText(basenameOf(path), markdown);
    if (text !== "") {
      found.push({ path, text: text.slice(0, MAX_GUIDANCE_CHARS), truncated: text.length > MAX_GUIDANCE_CHARS });
    }
  }
  return found;
}
