import { homedir } from "node:os";
import { type Shape, ShapeError, schemaText } from "./shape.js";

export { schemaText };

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

const REDACTED = "<redacted>";
/** A header line's whole value (`Authorization: Bearer …`, `x-api-key: …`, a cookie): its scheme and its token are one secret. */
const SECRET_HEADER = /\b((?:proxy-)?authorization|(?:set-)?cookie|x-[a-z-]*(?:key|token|secret|auth)[a-z-]*)(["']?\s*[:=]\s*)[^\r\n]*/gi;
/** A secret-named query parameter of a URL (`?X-Amz-Signature=…`): a signed URL carries its credential there. */
const SECRET_QUERY = /([?&][^=&\s"']*(?:sig|token|key|secret|credential|auth|password)[^=&\s"']*=)[^&\s"']+/gi;
/** A secret-named assignment (`API_KEY=…`, `"password": "…"`). */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi;
/** Credential-shaped runs: GitHub, Linear, OpenAI-style and Slack tokens, bearer values. */
const KEY_SHAPED = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|lin_(?:api|oauth)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/g;

function withoutSecrets(text: string): string {
  return text
    .replace(SECRET_HEADER, `$1$2${REDACTED}`)
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(KEY_SHAPED, REDACTED);
}

/**
 * The last `max` characters of `text`, scrubbed and on one line: header values, signed-URL parameters, secret-named
 * assignments and key-shaped runs are replaced and the reader's home directory is `~`. The whole text is scrubbed before
 * it is cut, so a secret the cut would have split is never shown in part. For an answer whose end is what matters (a
 * model's record comes last).
 */
export function scrubbedTail(text: string, home: string, max: number): string {
  const scrubbed = withoutSecrets(text);
  const line = (home === "" ? scrubbed : scrubbed.split(home).join("~")).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `…${line.slice(-(max - 1)).trimStart()}`;
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
        else if (char === "\"") inString = false;
      } else if (char === "\"") inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        spans.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return spans;
}

/** The most characters of a model's answer an `UnusableAnswerError` quotes: its end, where the record belongs. */
const RECEIVED_EXCERPT_CHARS = 300;

/**
 * A model's answer held no record that matches the shape asked for. The message names what came back: that it was
 * empty, or its scrubbed end. Typed so a caller that can settle without the record tells this failure from a port's.
 */
export class UnusableAnswerError extends Error {
  constructor(label: string, why: string, text: string) {
    const received = text.trim() === "" ? "the answer was empty" : `what came back ended: ${scrubbedTail(text, homedir(), RECEIVED_EXCERPT_CHARS)}`;
    super(`${label} answered no record that matches its schema (${why}); ${received}`);
    this.name = "UnusableAnswerError";
  }
}

/**
 * The last JSON object in a model's text that matches `shape`, wherever it sits (bare, in a fenced block, among prose);
 * an `UnusableAnswerError` naming the label and what came back when none does. The last, because the prompts ask for the
 * record at the end, and a narrated draft or a quoted tool answer may come before it.
 */
export function parseAnswer<T>(text: string, shape: Shape<T>, label: string): T {
  let closest: ShapeError | undefined;
  for (const span of objectSpans(text).reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(span);
    } catch {
      continue;
    }
    try {
      return shape.parse(value);
    } catch (error) {
      if (!(error instanceof ShapeError)) throw error;
      closest ??= error;
    }
  }
  throw new UnusableAnswerError(label, closest === undefined ? "no JSON object" : `the closest was wrong: ${closest.message}`, text);
}
