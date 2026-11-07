import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Shared skill-library code: where skills live, how a skill reference resolves, how a need ranks descriptions. */

export const SKILLS_ROOT_ENV = "SKILLS_ROOT";
export const SKILL_FILE = "SKILL.md";

/** `$SKILLS_ROOT` when set, else `~/.agents/skills` (a symlink to `~/.agents/available-skills` on this machine). */
export function skillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SKILLS_ROOT_ENV]?.trim();
  return configured || join(homedir(), ".agents", "skills");
}

const SKILL_SCHEME = /^skill:\/\//i;

/** `skill://<name>/<subpath>` is a convenience form over the bare name; the scheme is stripped. */
export function parseSkillRef(raw: string): { name: string; subpath?: string; error?: string } {
  const rest = raw.trim().replace(SKILL_SCHEME, "");
  const [name = "", ...restSegments] = rest.split("/");
  if (name === "") return { name: "", error: "the skill name is empty" };
  if (name === "." || name === "..") return { name, error: `"${name}" is not a skill name` };
  const subpath = restSegments.join("/");
  return { name, subpath: subpath === "" ? undefined : subpath };
}

/** True when `target` is not strictly inside `root`: outside it, or the root itself. */
function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

const FRONT_MATTER_MARK = "---";
const BLOCK_INDICATORS = new Set([">", "|", ">-", "|-", ">+", "|+"]);
const isIndented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

function unquoted(value: string): string {
  const quote = value.at(0);
  return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

/** Top-level `key: value` fields of a leading `---` block; folded and literal values joined by spaces. Empty when the block never closes. */
export function frontMatterFields(text: string): Record<string, string> {
  const lines = text.split("\n");
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== FRONT_MATTER_MARK) return fields;
  for (let at = 1; at < lines.length; at += 1) {
    const line = (lines[at] as string).replace(/\r+$/, "");
    if (line.trim() === FRONT_MATTER_MARK) return fields;
    const colon = line.indexOf(":");
    if (colon < 0 || line === "" || isIndented(line)) continue;
    let value = line.slice(colon + 1).trim();
    if (BLOCK_INDICATORS.has(value)) {
      const block: string[] = [];
      while (at + 1 < lines.length && (lines[at + 1] === "" || isIndented(lines[at + 1] as string))) {
        at += 1;
        block.push((lines[at] as string).trim());
      }
      value = block.join(" ");
    }
    fields[line.slice(0, colon).trim()] = unquoted(value);
  }
  return {};
}

export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export interface SkillEntry {
  name: string;
  description: string;
  directory: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory(); // follows symlinks: a linked skill directory is a skill
  } catch {
    return false;
  }
}

/**
 * Every skill in `root`: one entry per directory (symlinks to directories included) that holds a
 * readable `SKILL.md`, description collapsed to one line, sorted by name in byte order. A missing
 * root, a directory without `SKILL.md` and an unreadable file are skipped.
 */
export async function scanSkills(root: string): Promise<SkillEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const read = await Promise.all(
    names.map(async (name): Promise<SkillEntry | undefined> => {
      const directory = join(root, name);
      if (!(await isDirectory(directory))) return undefined;
      const text = await readText(join(directory, SKILL_FILE));
      if (text === undefined) return undefined;
      const description = (frontMatterFields(text).description ?? "").split(/\s+/).filter((w) => w !== "").join(" ");
      return { name, description, directory };
    }),
  );
  return read.filter((e): e is SkillEntry => e !== undefined).sort((a, b) => compareBytes(a.name, b.name));
}

const WORD = /[a-z0-9]+/g;
const STOPWORDS = new Set(
  "a about an and are as at be by for from has have if in into is it its me my not of on or our that the this to us was we were with you your".split(
    " ",
  ),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** A shared prefix is evidence only from three characters up: `me` must not match `merge`. */
const MIN_PREFIX = 3;

function overlaps(need: string, described: readonly string[]): boolean {
  return described.some(
    (w) => w === need || (Math.min(w.length, need.length) >= MIN_PREFIX && (w.startsWith(need) || need.startsWith(w))),
  );
}

function inverseFrequency(word: string, corpus: readonly { described: readonly string[] }[]): number {
  const documents = corpus.filter((e) => overlaps(word, e.described)).length;
  return Math.log(1 + (corpus.length - documents + 0.5) / (documents + 0.5));
}

/**
 * Rank skills against a need: tokenize on non-alphanumerics, lowercase, drop 1-char tokens and function
 * words; a need word matches a description word that equals it or shares a prefix (3+ chars); each matched
 * word is worth its inverse document frequency over the library. Ties go to name in byte order. No match, no entry.
 */
export function rankSkills(skills: readonly SkillEntry[], need: string): { skill: SkillEntry; score: number }[] {
  const needWords = [...new Set(words(need))];
  if (needWords.length === 0 || skills.length === 0) return [];
  const corpus = skills.map((skill) => ({ skill, described: words(skill.description) }));
  const frequency = new Map(needWords.map((w) => [w, inverseFrequency(w, corpus)] as const));
  return corpus
    .map((e) => ({
      skill: e.skill,
      score: needWords.filter((w) => overlaps(w, e.described)).reduce((t, w) => t + (frequency.get(w) ?? 0), 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || compareBytes(a.skill.name, b.skill.name));
}

export type ResolvedSkillFile =
  | { name: string; path: string; content: string }
  | { name: string; error: string };

/** `<root>/<name>/<relative>` (default `SKILL.md`). A reference that leaves the root, a path that leaves the skill directory, or a missing file is an `error`, not a throw. */
export async function resolveSkillFile(root: string, nameRef: string, path?: string): Promise<ResolvedSkillFile> {
  const parsed = parseSkillRef(nameRef);
  if (parsed.error !== undefined) return { name: parsed.name || nameRef, error: parsed.error };
  const base = resolve(root);
  const directory = join(base, parsed.name);
  const rel = path ?? parsed.subpath ?? SKILL_FILE;
  const file = resolve(join(directory, rel));
  if (escapes(base, file)) return { name: parsed.name, error: `skill "${parsed.name}" resolves outside the skills root` };
  if (escapes(resolve(directory), file)) {
    return { name: parsed.name, error: `path "${rel}" resolves outside the skill directory` };
  }
  const content = await readText(file);
  if (content === undefined) return { name: parsed.name, error: `skill "${parsed.name}" has no readable ${rel}` };
  return { name: parsed.name, path: file, content };
}
