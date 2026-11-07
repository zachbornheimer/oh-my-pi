export type RunSource = "transcript" | "document";

export interface Parameter {
  readonly name: string;
  /** The literal the source had, when it had one. */
  readonly example?: string;
}

export interface Parameterized {
  /** The runs with each parameter written `{name}`; same order as the input, `undefined` stays `undefined`. */
  readonly runs: readonly (string | undefined)[];
  readonly parameters: readonly Parameter[];
  /** Each parameter's original text, so `{name}` can be turned back into what the source said. */
  readonly literals: Readonly<Record<string, string>>;
}

const HOME_PATH = /(?:\/Users|\/home)\/[^/\s'"]+/;
const HOME_NAME = "home";
const HOST_LABEL = /[a-z0-9][a-z0-9-]*\./y;
const HOST_SUFFIX = /(?:com|org|net|io|dev|app|lan|local|co|us|ai|edu|gov)\b/y;
const HOST_START = /[a-z0-9]/;
const WORD_CHARACTER = /\w/;

/** Where a hostname that starts at `start` ends: dotted labels, then a known suffix, preferring the longest. */
function hostnameEnd(run: string, start: number): number | undefined {
  if (!HOST_START.test(run[start]!) || (start > 0 && WORD_CHARACTER.test(run[start - 1]!))) return undefined;
  const labelEnds: number[] = [];
  for (let at = start; ; ) {
    HOST_LABEL.lastIndex = at;
    const label = HOST_LABEL.exec(run);
    if (label === null) break;
    at += label[0].length;
    labelEnds.push(at);
  }
  for (const labelEnd of labelEnds.reverse()) {
    HOST_SUFFIX.lastIndex = labelEnd;
    const suffix = HOST_SUFFIX.exec(run);
    if (suffix !== null) return labelEnd + suffix[0].length;
  }
  return undefined;
}

/** Every hostname in `run` (`api.example.com`), left to right and without overlap. */
export function hostnamesIn(run: string): string[] {
  const found: string[] = [];
  for (let start = 0; start < run.length; ) {
    const end = hostnameEnd(run, start);
    if (end === undefined) start += 1;
    else {
      found.push(run.slice(start, end));
      start = end;
    }
  }
  return found;
}
const HOST_NAME = "host";
const IDENTIFIER =
  /\b(?:(?:at|proj|sess)-[a-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
const ID_NAME = "id";
const DOCUMENT_PLACEHOLDER = /<([A-Za-z][\w.-]*)>/g;
const POSITIONAL_WORD = /^[a-z][a-z0-9_-]{2,}$/;
const POSITIONAL_NAME = "target";
const FIRST_POSITIONAL_INDEX = 2;
/** A literal that repeats in this many steps is an input, not a coincidence. */
const MIN_STEPS_FOR_AN_INPUT = 2;
const MIN_STEPS_FOR_A_POSITIONAL_INPUT = 3;

const replaceAll = (text: string, literal: string, name: string): string => text.split(literal).join(`{${name}}`);

/** `file.json` -> `file_json`: an input name is lower-case words joined by underscores. */
const inputName = (placeholder: string): string =>
  placeholder.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function documentParameters(runs: readonly (string | undefined)[]): Parameterized {
  const literals: Record<string, string> = {};
  const rewritten = runs.map((run) =>
    run?.replace(DOCUMENT_PLACEHOLDER, (_whole, inner: string) => {
      const name = inputName(inner);
      literals[name] = `<${inner}>`;
      return `{${name}}`;
    })
  );
  return { runs: rewritten, parameters: Object.keys(literals).map((name) => ({ name })), literals };
}

/** Distinct matches of `pattern` in more than one step, in the order they first appear. */
function repeatedLiterals(
  runs: readonly (string | undefined)[],
  found: (run: string) => string[],
  minSteps: number,
): string[] {
  const stepsByLiteral = new Map<string, Set<number>>();
  runs.forEach((run, index) => {
    if (run === undefined) return;
    for (const literal of found(run)) {
      stepsByLiteral.set(literal, (stepsByLiteral.get(literal) ?? new Set()).add(index));
    }
  });
  return [...stepsByLiteral].filter(([, steps]) => steps.size >= minSteps).map(([literal]) => literal);
}

const positionalWords = (run: string): string[] =>
  run.split(/\s+/).slice(FIRST_POSITIONAL_INDEX).filter((word) => POSITIONAL_WORD.test(word));

/**
 * Turns the literals a process repeats into inputs. A transcript's home directory is always `{home}`; hostnames, ids and
 * a bare word that is the same argument of three or more commands become `{host}`, `{id}` and `{target}` (`{host_2}` for
 * a second one). A document's `<site>` placeholders become `{site}`. Nothing that appears in one step only is touched.
 */
export function parameterize(runs: readonly (string | undefined)[], source: RunSource): Parameterized {
  if (source === "document") return documentParameters(runs);
  const literals: Record<string, string> = {};
  const parameters: Parameter[] = [];
  let current = [...runs];
  const adopt = (name: string, literal: string): void => {
    literals[name] = literal;
    parameters.push({ name, example: literal });
    current = current.map((run) => (run === undefined ? undefined : replaceAll(run, literal, name)));
  };
  const home = runs.map((run) => (run === undefined ? null : HOME_PATH.exec(run))).find((match) => match !== null);
  if (home) adopt(HOME_NAME, home[0]);
  const named = (base: string, found: readonly string[]): void =>
    found.forEach((literal, index) => adopt(index === 0 ? base : `${base}_${index + 1}`, literal));
  named(HOST_NAME, repeatedLiterals(current, hostnamesIn, MIN_STEPS_FOR_AN_INPUT));
  named(ID_NAME, repeatedLiterals(current, (run) => run.match(IDENTIFIER) ?? [], MIN_STEPS_FOR_AN_INPUT));
  named(POSITIONAL_NAME, repeatedLiterals(current, positionalWords, MIN_STEPS_FOR_A_POSITIONAL_INPUT));
  return { runs: current, parameters, literals };
}

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** The names of the declared inputs a text uses, in order of first use. */
export function placeholdersIn(text: string, declared: ReadonlySet<string>): string[] {
  const used = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).filter((name) => declared.has(name));
  return [...new Set(used)];
}

/** A pattern that matches the text a `run` was derived from: each declared `{name}` stands for any text. */
export function sourcePattern(run: string, declared: ReadonlySet<string>): RegExp {
  const pieces = run.split(PLACEHOLDER);
  const escaped = pieces.map((piece, index) => {
    const isName = index % 2 === 1;
    if (isName && declared.has(piece)) return ".+?";
    return (isName ? `{${piece}}` : piece).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(escaped.join(""), "s");
}
