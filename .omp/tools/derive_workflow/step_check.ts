/** The atask check grammar a step's `check` is written in: `run: <command>` or `<preset>: <subject>`. */
export const CHECK_PRESETS = ["run", "file_exists", "file_absent", "http_ok", "grep"] as const;
/**
 * Not atask grammar and not runnable: what a gate with no command must show to pass, in the source's words
 * (`states: no conformance violations remain`). Only a step with no `run` may carry one.
 */
export const STATED_VERDICT = "states";

const CHECK_SHAPE = /^([a-z_]+):\s*(.+)$/s;
/** A command that cannot fail shows nothing worked. */
const CANNOT_FAIL = /^(?:echo|printf|true|exit\s+0|:)(?:\s|$)/;
const URL_START = /^https?:\/\//;
const URL_PLACEHOLDER = /^\{[a-z0-9_]+\}/;
const GREP_PATTERN_OPTION = /\spattern=\S/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
export const NO_CHECK = "";

/**
 * Why a step check is not valid atask grammar, or undefined when it is. An empty check means the step has none.
 * The reasons are written for the model that wrote it.
 */
export function checkProblem(check: string, inputs: ReadonlySet<string>, hasCommand: boolean): string | undefined {
  const trimmed = check.trim();
  if (trimmed === NO_CHECK) return undefined;
  const shape = CHECK_SHAPE.exec(trimmed);
  const preset = shape?.[1] ?? "";
  const subject = shape?.[2]?.trim() ?? "";
  if (preset === STATED_VERDICT) {
    return hasCommand ? `a step with a command needs a check that can run, not "${STATED_VERDICT}:"` : undefined;
  }
  if (!(CHECK_PRESETS as readonly string[]).includes(preset)) {
    const presets = hasCommand ? CHECK_PRESETS : [...CHECK_PRESETS, STATED_VERDICT];
    return `a check is "<preset>: <subject>" with a preset from ${
      presets.join(", ")
    }, or empty for none; got "${trimmed}"`;
  }
  if (preset === "run" && CANNOT_FAIL.test(subject)) {
    return `"${subject}" cannot fail, so it shows nothing: check a real result, such as a file's contents or an exit status`;
  }
  if (preset === "http_ok" && !URL_START.test(subject.replace(URL_PLACEHOLDER, "http://x"))) {
    return `http_ok takes a URL that starts with http:// or https://; got "${subject}"`;
  }
  if (preset === "grep" && !GREP_PATTERN_OPTION.test(subject)) {
    return `grep takes "<file> pattern=<regex>"; got "${subject}"`;
  }
  const unknown = [...subject.matchAll(PLACEHOLDER)].map((match) => match[1]!).find((name) => !inputs.has(name));
  return unknown === undefined
    ? undefined
    : `"{${unknown}}" is not one of the inputs (${[...inputs].join(", ") || "none"})`;
}
