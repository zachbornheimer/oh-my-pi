import { isCapabilityName } from "./types.js";

/** Words that say how a capability works instead of what it does: a name carrying one is renamed for the thing it yields. */
export const HOW_WORDS: ReadonlySet<string> = new Set([
  "with",
  "via",
  "using",
  "llm",
  "gpt",
  "claude",
  "openai",
  "regex",
  "sqlite",
  "redis",
  "ssh",
  "curl",
  "script",
  "cli",
]);
/** Verbs that fit any capability and so name none: a name ending in one is renamed for the thing it yields or a specific verb. */
export const BANNED_LAST_WORDS: ReadonlySet<string> = new Set([
  "run",
  "check",
  "handle",
  "process",
  "do",
  "manage",
  "execute",
  "perform",
  "fetch",
  "get",
]);
export const MAX_NAME_SEGMENTS = 4;
export const MAX_NAME_CHARS = 48;

/** Why `name` is not an irreducible, WHAT-not-HOW capability name; undefined when it is one. Written for the model. */
export function nameProblem(name: string, namespace?: string): string | undefined {
  if (!isCapabilityName(name)) {
    return `"${name}" must be lower-case snake_case words joined by dots, such as "webmaster.page.seo"`;
  }
  if (name.length > MAX_NAME_CHARS || name.split(".").length > MAX_NAME_SEGMENTS) {
    return `"${name}" is too long: at most ${MAX_NAME_SEGMENTS} dotted parts and ${MAX_NAME_CHARS} characters; drop every word that does not change the meaning`;
  }
  const how = name.split(/[._]/).find((word) => HOW_WORDS.has(word));
  if (how !== undefined) {
    return `"${name}" says how, not what ("${how}"): name the thing it yields or does, whatever it is built from`;
  }
  const last = name.split(/[._]/).at(-1) ?? "";
  if (BANNED_LAST_WORDS.has(last)) {
    return `"${name}" ends in the filler verb "${last}", which fits every capability and names none: end it in the noun it yields or a specific verb (such as "site.uptime" or "photo.duplicate.find", not "uptime.check")`;
  }
  if (namespace !== undefined && !name.startsWith(`${namespace}.`)) {
    return `"${name}" must start with "${namespace}."`;
  }
  return undefined;
}
