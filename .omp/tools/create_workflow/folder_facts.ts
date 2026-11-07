/** Pure readers of a file's text: each returns the lines of an inventory, every one carrying where it is (`path:line`). */

const MAX_HEADINGS_PER_DOCUMENT = 25;
const MAX_INTRO_LINES = 6;
const MAX_HEAD_COMMENT_LINES = 3;
const MAX_SYMBOLS_PER_FILE = 16;
const MAX_VERBS_PER_FILE = 12;
const MAX_BLOCKS_PER_FILE = 5;
const MAX_BLOCK_LINES = 24;
const MAX_BLOCK_CHARS = 320;
const MAX_LINE_CHARS = 160;
const MAX_DATA_HEAD_LINES = 3;

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
const linesOf = (text: string): string[] => text.split("\n");

/** The headings of a markdown document, and for the project's own entry documents the first lines of prose. */
export function documentFacts(path: string, text: string, withIntro: boolean): string[] {
  const lines = linesOf(text);
  const headings = lines.flatMap((line, index) =>
    /^#{1,4}\s+\S/.test(line) ? [`${path}:${index + 1}: ${clip(line.trim(), MAX_LINE_CHARS)}`] : []
  ).slice(0, MAX_HEADINGS_PER_DOCUMENT);
  const intro = withIntro
    ? lines.flatMap((line, index) =>
      line.trim() === "" || /^(#|[-=`|<>]|---)/.test(line.trim())
        ? []
        : [`${path}:${index + 1}: ${clip(line.trim(), MAX_LINE_CHARS)}`]
    ).slice(0, MAX_INTRO_LINES)
    : [];
  return [...intro, ...headings];
}

/** The `[tasks.<name>]` tables of a mise.toml with their description, and a Makefile's targets. */
export function taskFacts(path: string, text: string): string[] {
  const lines = linesOf(text);
  if (path.endsWith("Makefile")) {
    return lines.flatMap((line, index) => {
      const target = /^([A-Za-z][\w.-]*):(?!=)/.exec(line);
      return target === null ? [] : [`${path}:${index + 1}: make ${target[1]}`];
    });
  }
  return lines.flatMap((line, index) => {
    const task = /^\[tasks\.["']?([^\]"']+)["']?\]/.exec(line);
    if (task === null) return [];
    const description = lines.slice(index + 1, index + 8).map((next) => /^description\s*=\s*["'](.*)["']/.exec(next))
      .find((m) => m);
    return [
      `${path}:${index + 1}: mise run ${task[1]}${description ? ` -- ${clip(description[1]!, MAX_LINE_CHARS)}` : ""}`,
    ];
  });
}

/** The scripts of a package.json. */
export function packageScriptFacts(path: string, text: string): string[] {
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.entries(scripts).map(([name, command]) =>
      `${path}: ${name} = ${clip(String(command), MAX_LINE_CHARS)}`
    );
  } catch {
    return [];
  }
}

/** The comment lines a script opens with (after a shebang), which say what it is for. */
export function headCommentFacts(path: string, text: string): string[] {
  const lines = linesOf(text).filter((line) => !line.startsWith("#!"));
  const comment = /^\s*(?:#|\/\/|\*|\/\*\*?|"""|''')\s?(.*)$/;
  const head: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && head.length === 0) continue;
    const match = comment.exec(line);
    if (match === null) break;
    const words = match[1]!.replace(/(?:"""|''')$/, "").trim();
    if (words !== "") head.push(words);
    if (head.length >= MAX_HEAD_COMMENT_LINES) break;
  }
  return head.length === 0 ? [] : [`${path}: ${clip(head.join(" "), MAX_LINE_CHARS)}`];
}

const SYMBOL_PATTERNS: readonly RegExp[] = [
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|enum|interface|type|abstract class)\s+([A-Za-z_$][\w$]*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[([]/,
  /^(?:async\s+)?def\s+([A-Za-z]\w*)/,
  /^class\s+([A-Za-z]\w*)/,
  /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/,
];

const BLOCK_TRIGGERS: readonly RegExp[] = [
  /\bz\.enum\(/,
  /^\s*(?:export\s+)?(?:const|let)\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*[[{]/,
  /^\s*(?:export\s+)?type\s+\w+\s*=\s*(?:\|?\s*["'`]|$)/,
  /^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+/,
  /^[A-Z][A-Z0-9_]{2,}\s*=\s*[[({]/,
  /^class\s+\w+\((?:\w+,\s*)?(?:str,\s*)?Enum\)/,
  /^const\s*\(\s*$/,
];

const VERB_PATTERNS: readonly RegExp[] = [
  /\.(?:command|subcommand|addCommand)\(\s*["'`][^"'`]+["'`]/,
  /\bUse:\s*"[^"]+"/,
  /\.add_parser\(\s*["'][^"']+["']/,
];

const OPENING = /[[({]/g;
const CLOSING = /[\])}]/g;
const countOf = (line: string, pattern: RegExp): number => line.match(pattern)?.length ?? 0;

/** A trigger line and the lines after it that belong to the same list, joined into one line. */
function blockAt(lines: readonly string[], start: number): string {
  const taken: string[] = [];
  let depth = 0;
  let opened = false;
  for (let at = start; at < Math.min(lines.length, start + MAX_BLOCK_LINES); at++) {
    const line = lines[at]!.trim();
    depth += countOf(line, OPENING) - countOf(line, CLOSING);
    opened ||= countOf(line, OPENING) > 0;
    if (line !== "" && !line.startsWith("//") && !line.startsWith("#")) taken.push(line);
    if (
      opened
        ? depth <= 0
        : /;\s*$/.test(line) || !/[|=]\s*$/.test(line) && !(lines[at + 1] ?? "").trim().startsWith("|")
    ) break;
  }
  return clip(taken.join(" "), MAX_BLOCK_CHARS);
}

/**
 * What a source file offers: the names it exports (functions, classes, constants), the lists that enumerate things (an
 * enum, a union of literals, an upper-case constant list), and the CLI verbs it registers.
 */
export function sourceFacts(path: string, text: string): string[] {
  const lines = linesOf(text);
  const symbols: string[] = [];
  const blocks: string[] = [];
  const verbs: string[] = [];
  const names = new Set<string>();
  lines.forEach((line, index) => {
    const symbol = SYMBOL_PATTERNS.map((pattern) => pattern.exec(line)).find((match) => match !== null);
    if (symbol && symbols.length < MAX_SYMBOLS_PER_FILE && !names.has(symbol[1]!)) {
      names.add(symbol[1]!);
      symbols.push(`${symbol[1]} (L${index + 1})`);
    }
    if (blocks.length < MAX_BLOCKS_PER_FILE && BLOCK_TRIGGERS.some((trigger) => trigger.test(line))) {
      blocks.push(`  ${path}:${index + 1}: ${blockAt(lines, index)}`);
    }
    const verb = VERB_PATTERNS.map((pattern) => pattern.exec(line)).find((match) => match !== null);
    if (verb && verbs.length < MAX_VERBS_PER_FILE) {
      verbs.push(`  ${path}:${index + 1}: ${clip(verb[0].trim(), MAX_LINE_CHARS)}`);
    }
  });
  if (symbols.length + blocks.length + verbs.length === 0) return [];
  return [...(symbols.length === 0 ? [] : [`${path}: ${symbols.join(", ")}`]), ...blocks, ...verbs];
}

/** The first `id`, `name` and `description` lines of a YAML or JSON data file (a rule, a workflow, a job definition). */
export function dataFacts(path: string, text: string): string[] {
  const keyed = linesOf(text).flatMap((line) =>
    /^\s{0,4}["']?(?:id|name|description|title)["']?\s*[:=]\s*\S/.test(line)
      ? [`${clip(line.trim(), MAX_LINE_CHARS)}`]
      : []
  ).slice(0, MAX_DATA_HEAD_LINES);
  return keyed.length === 0 ? [] : [`${path}: ${keyed.join(" | ")}`];
}

const DATA_EXAMPLES_PER_DIRECTORY = 3;

/** Data files grouped by directory: how many each holds and the first few as examples, so a rule set reads as one line. */
export function dataDirectoryFacts(paths: readonly string[], texts: ReadonlyMap<string, string>): string[] {
  const byDirectory = new Map<string, string[]>();
  for (const path of paths) {
    const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), path]);
  }
  return [...byDirectory].map(([directory, files]) => {
    const examples = files.slice(0, DATA_EXAMPLES_PER_DIRECTORY).flatMap((file) =>
      dataFacts(file, texts.get(file) ?? "")
    );
    return [`${directory}/: ${files.length} files`, ...examples.map((example) => `  ${example}`)].join("\n");
  });
}
