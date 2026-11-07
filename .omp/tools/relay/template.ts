import { homedir } from "node:os";

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * A template with each `{{name}}` replaced by its value in one pass, so a value that itself contains `{{other}}`
 * (a ticket quoting a template) is never expanded. A placeholder with no value throws: a prompt that went out with a
 * hole in it is worse than a failed step.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>, label: string): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${label}: the template has {{${name}}} and no value was given for it`);
    return value;
  });
}

/**
 * Every balanced `{…}` span in `text`, in order, counting braces only outside JSON strings. A model's answer is all of its
 * steps' text joined, so narration may hold braces of its own (`${{ secrets.X }}`, quoted `gh` JSON) around the record.
 */
function objectSpans(text: string): string[] {
  const spans: string[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        spans.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return spans;
}

const SECRET_HEADER = /\b((?:proxy-)?authorization|(?:set-)?cookie|x-[a-z-]*(?:key|token|secret|auth)[a-z-]*)(["']?\s*[:=]\s*)[^\r\n]*/gi;
const SECRET_QUERY = /([?&][^=&\s"']*(?:sig|token|key|secret|credential|auth|password)[^=&\s"']*=)[^&\s"']+/gi;
const SECRET_VALUE =
  /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9_-]{0,40}(?:password|passwd|secret|token|api_?key|auth_?key|salt|private_?key))(?:['"]\s*,|['"]?\s*(?:=>|=|:))\s*['"]?)[^'"\s,;)<]+/gi;
const ANY_HOME = /\/(?:Users|home)\/[^/\s"'`]+(?=\/|\b)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEY_WITH_PREFIX = /\b(?:sk|pk|ghp|gho|ghs|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g;
const OPAQUE_RUN = /\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}\b/g;
const BEARER = /\bBearer\s+\S+/gi;
const REDACTED = "<redacted>";

/** The text with header values, signed-URL parameters, secret-named assignments, tokens and emails replaced, and home paths as `~`. */
export function scrubbed(text: string, home = homedir()): string {
  return text
    .replace(SECRET_HEADER, `$1$2${REDACTED}`)
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(SECRET_VALUE, "$1REDACTED")
    .split(home)
    .join("~")
    .replace(ANY_HOME, "~")
    .replace(EMAIL, "<email>")
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(KEY_WITH_PREFIX, REDACTED)
    .replace(OPAQUE_RUN, REDACTED);
}

/** The last `max` characters of `text`, scrubbed whole before it is cut so a secret the cut would split is never shown in part, on one line. */
export function scrubbedTail(text: string, max: number, home = homedir()): string {
  const line = scrubbed(text, home).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `…${line.slice(-(max - 1)).trimStart()}`;
}

/** The most characters of a model's answer an `UnusableAnswerError` quotes: its end, where the record belongs. */
const RECEIVED_EXCERPT_CHARS = 300;

/**
 * A model's answer held no record that matches the schema asked for. The message names what came back: that it was
 * empty, or its scrubbed end. Typed so a caller that can settle without the record tells this failure from a port's.
 */
export class UnusableAnswerError extends Error {
  constructor(label: string, why: string, text: string) {
    const received = text.trim() === "" ? "the answer was empty" : `what came back ended: ${scrubbedTail(text, RECEIVED_EXCERPT_CHARS)}`;
    super(`${label} answered no record that matches its schema (${why}); ${received}`);
    this.name = "UnusableAnswerError";
  }
}

/**
 * The last JSON object in a model's text that `validate` accepts, wherever it sits (bare, in a fenced block, among
 * prose); an `UnusableAnswerError` naming the label and what came back when none does. The last, because the prompts
 * ask for the record at the end, and a narrated draft or a quoted tool answer may come before it.
 */
export function parseAnswer<T>(text: string, validate: (value: unknown) => T, label: string): T {
  // The error reported is the one of the largest object that parsed: the record that failed on a refinement, not an
  // object nested inside it.
  let closest: { message: string; length: number } | undefined;
  for (const span of objectSpans(text).reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(span);
    } catch {
      continue;
    }
    try {
      return validate(value);
    } catch (error) {
      if (closest === undefined || span.length > closest.length) closest = { message: (error as Error).message, length: span.length };
    }
  }
  throw new UnusableAnswerError(label, closest === undefined ? "no JSON object" : `the closest was wrong: ${closest.message}`, text);
}
