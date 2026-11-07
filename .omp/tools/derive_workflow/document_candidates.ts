import { type Candidate, candidateId, type Candidates, cleanTitle } from "./candidates.ts";
import { commandLabel, isReadOnlyCommand } from "./commands.ts";

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const NUMBERED_ITEM = /^(\s*)\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const FRONTMATTER_FENCE = "---";
const SHELL_FENCES: ReadonlySet<string> = new Set(["", "sh", "bash", "zsh", "shell", "console", "fish"]);
const INLINE_CODE = /`([^`\n]+)`/g;
const PROMPT = /^\$\s+/;
const BOLD_LEAD = /^\*\*(.+?)\*\*/;
/** A first word that names a program: a bare name or a path to a script, not a flag, a slash command or a placeholder. */
const PATH_PREFIXES = ["../", "./", "~/", "/"] as const;
export function isProgramWord(word: string): boolean {
  const prefix = PATH_PREFIXES.find((candidate) => word.startsWith(candidate)) ?? "";
  const [name = "", ...directories] = word.slice(prefix.length).split("/");
  return /^[A-Za-z][\w.-]*$/.test(name) && directories.every((part) => /^[\w.-]+$/.test(part));
}
const MIN_COMMAND_WORDS = 2;
const INDENTED_CODE = /^(?: {4,}|\t)\S/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const COMMENT_LEAD = /^#+\s*/;
const TRAILING_BACKSLASHES = /\\+$/;

/** The first inline code span of a line that reads as a command with arguments (`webmaster check <site>`). */
export function commandIn(line: string): string | undefined {
  for (const match of line.matchAll(INLINE_CODE)) {
    const span = match[1]!.trim();
    const words = span.split(/\s+/);
    if (words.length >= MIN_COMMAND_WORDS && isProgramWord(words[0]!) && !span.startsWith("/")) return span;
  }
  return undefined;
}

/** Whether an indented line is a command example: a program (or script path) followed by arguments, or a path to a script. */
function looksLikeCommand(line: string): boolean {
  const words = line.split(/\s+/);
  return isProgramWord(words[0]!) && (words.length >= MIN_COMMAND_WORDS || words[0]!.includes("/"));
}

/** A line's title: its bold lead ("**Check.** ..."), else its first sentence, with the markdown taken off. */
function titleOf(line: string): string {
  const bold = BOLD_LEAD.exec(line);
  if (bold !== null) return cleanTitle(bold[1]!);
  const plain = line.replace(INLINE_CODE, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return cleanTitle(plain.split(/(?<=[.!?])\s/)[0] ?? plain);
}

interface Position {
  readonly line: number;
  readonly section: string;
}

interface ParsedLine extends Position {
  readonly text: string;
  /** True for a command in a code block, whose whole line is the command. */
  readonly fenced: boolean;
  /** The `# comment` line right above an indented command: what the example is for. */
  readonly comment?: string;
}

/** A line is "continued" by a following indented line that is not itself a list item or a fence. */
const isContinuation = (line: string): boolean =>
  /^\s{2,}\S/.test(line) && !NUMBERED_ITEM.test(line) && !FENCE.test(line) && !/^\s*[-*]\s/.test(line);

function firstContentLine(lines: readonly string[]): number {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return 0;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  return end < 0 ? 0 : end + 1;
}

/** A command line with its `\\` continuation lines joined; `next` is the index of the line after it. */
function joinedCommand(lines: readonly string[], first: number): { readonly command: string; readonly next: number } {
  let command = lines[first]!.trim().replace(PROMPT, "");
  let next = first + 1;
  while (TRAILING_BACKSLASHES.test(command) && next < lines.length) {
    command = `${command.replace(TRAILING_BACKSLASHES, "").trim()} ${lines[next]!.trim()}`;
    next += 1;
  }
  return { command, next };
}

/**
 * Numbered-list lines (with their indented continuation), the commands of shell fences and the commands of indented
 * example blocks (the `scripts/x.py ...` lines of a docstring or runbook, each with the `# comment` above it), in
 * document order. Fenced blocks of anything else (diagrams, pseudocode) are skipped.
 */
export function parsedLines(text: string, range: { from?: number; to?: number }): ParsedLine[] {
  const lines = text.split("\n");
  const parsed: ParsedLine[] = [];
  let section = "";
  let fence: { readonly marker: string; readonly shell: boolean } | undefined;
  let inList = false;
  let comment: string | undefined;
  let at = firstContentLine(lines);
  while (at < lines.length) {
    const raw = lines[at]!;
    const lineNumber = at + 1;
    const opened = FENCE.exec(raw);
    if (fence !== undefined) {
      if (opened !== null && opened[2]!.startsWith(fence.marker) && opened[3] === "") fence = undefined;
      else if (fence.shell && raw.trim() !== "" && !raw.trim().startsWith("#")) {
        const { command, next } = joinedCommand(lines, at);
        parsed.push({ line: lineNumber, section, text: command, fenced: true });
        at = next;
        continue;
      }
      at += 1;
      continue;
    }
    if (opened !== null) {
      fence = { marker: opened[2]!, shell: SHELL_FENCES.has(opened[3]!.toLowerCase()) };
      at += 1;
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading !== null) {
      section = heading[1]!.trim();
      inList = false;
      comment = undefined;
      at += 1;
      continue;
    }
    if (raw.trim() === "") {
      at += 1;
      continue;
    }
    if (INDENTED_CODE.test(raw) && !inList) {
      const body = raw.trim();
      if (body.startsWith("#")) comment = body.replace(COMMENT_LEAD, "");
      else if (looksLikeCommand(body)) {
        const { command, next } = joinedCommand(lines, at);
        parsed.push({
          line: lineNumber,
          section,
          text: command,
          fenced: true,
          ...(comment === undefined ? {} : { comment }),
        });
        comment = undefined;
        at = next;
        continue;
      }
      at += 1;
      continue;
    }
    if (!/^\s/.test(raw)) {
      inList = false;
      comment = undefined;
    }
    const item = NUMBERED_ITEM.exec(raw);
    if (item === null) {
      inList = inList || LIST_ITEM.test(raw);
      at += 1;
      continue;
    }
    inList = true;
    let body = item[2]!;
    at += 1;
    while (at < lines.length && isContinuation(lines[at]!)) body += ` ${lines[at++]!.trim()}`;
    parsed.push({ line: lineNumber, section, text: body, fenced: false });
  }
  return parsed.filter((entry) =>
    entry.line >= (range.from ?? 1) && entry.line <= (range.to ?? Number.POSITIVE_INFINITY)
  );
}

const PYTHON_FILE = /\.py$/;
const DOCSTRING_QUOTE = /^\s*[rRuUbB]?("""|''')/;

/**
 * The part of a file that is prose: all of a document, but only the module docstring of a Python script (its code
 * is indented like an example block and is not a procedure). Lines outside the prose are blanked, so line numbers hold.
 */
export function proseOf(text: string, path?: string): string {
  if (path === undefined || !PYTHON_FILE.test(path)) return text;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => DOCSTRING_QUOTE.test(line));
  if (start < 0) return "";
  const quote = DOCSTRING_QUOTE.exec(lines[start]!)![1]!;
  const opening = lines[start]!.indexOf(quote) + quote.length;
  const sameLine = lines[start]!.indexOf(quote, opening) >= 0;
  const end = sameLine ? start : lines.findIndex((line, index) => index > start && line.includes(quote));
  const last = end < 0 ? lines.length - 1 : end;
  return lines.map((line, index) => (index >= start && index <= last ? line : "")).join("\n");
}

/**
 * The candidate steps of a document: every numbered-list line, and every command of a code block or example, in order.
 * A numbered line carries the first command written in backticks (`webmaster check <site>`), if any. A command that
 * only looks (`cat`, `ls`, `git status`) is dropped as a read.
 */
export function documentCandidates(
  text: string,
  range: { from?: number; to?: number } = {},
  path?: string,
): Candidates {
  const found = parsedLines(proseOf(text, path), range);
  const candidates: Candidate[] = [];
  let reads = 0;
  for (const entry of found) {
    const command = entry.fenced ? entry.text : commandIn(entry.text);
    if (command !== undefined && isReadOnlyCommand(command)) {
      reads += 1;
      continue;
    }
    candidates.push({
      id: candidateId(candidates.length),
      title: entry.fenced
        ? cleanTitle(entry.comment ?? `Run ${commandLabel(command!)}`)
        : titleOf(entry.text),
      ...(command === undefined ? {} : { command }),
      commandOnly: entry.fenced,
      text: entry.fenced
        ? `A command in a code block: ${command}${
          entry.comment === undefined ? "" : `\nWhat it is for: ${entry.comment}`
        }`
        : `A numbered line: ${entry.text}`,
      context: entry.section === "" ? "" : `Section: ${entry.section}`,
      evidence: [{ line: entry.line }],
      retried: false,
    });
  }
  return { candidates, seen: found.length, dropped: { reads, retries: 0, failed: 0 } };
}
