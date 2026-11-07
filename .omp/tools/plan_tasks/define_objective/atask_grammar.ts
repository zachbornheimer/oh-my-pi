import { groundedSpecProblems, regressionProblems } from "./project_context.js";
import { CHECK_SIZES, type ProjectContext, type TaskSpec } from "./types.js";

/** The longest title atask items carry. */
export const MAX_TITLE_LENGTH = 80;

/** The presets `atask help add` lists for `--proof` and `--regression`. */
export const CHECK_PRESETS = [
  "build",
  "ci",
  "file_absent",
  "file_blake3",
  "file_exists",
  "go_test",
  "grep",
  "http_ok",
  "js_test",
  "lint",
  "php_test",
  "pl_test",
  "playwright_run",
  "pr_merged",
  "py_test",
  "rb_test",
  "rs_test",
  "run",
  "sh_test",
  "swift_test",
] as const;

/** Presets atask refuses a subject for: `lint:` is right, `lint: .` is an error. */
const NO_SUBJECT_ALLOWED: ReadonlySet<string> = new Set(["build", "ci", "lint"]);

/** Presets atask refuses (or that mean nothing) without a subject. */
const SUBJECT_REQUIRED: ReadonlySet<string> = new Set([
  "run",
  "go_test",
  "js_test",
  "py_test",
  "playwright_run",
  "pr_merged",
  "file_absent",
  "file_blake3",
  "file_exists",
  "grep",
  "http_ok",
]);

const RUN_PRESET = "run";
const CHECK_SHAPE = /^([a-z_]+):\s*(.*)$/s;
const NON_IMPERATIVE_LEAD = new Set(["the", "a", "an", "to", "this", "that", "it", "we", "i", "how", "why", "what"]);
const INFLECTED_ENDING = /(?:ing|ed)$/;
const MIN_INFLECTED_LENGTH = 5;
const IMPERATIVES_ENDING_INFLECTED = new Set([
  "bring",
  "embed",
  "exceed",
  "feed",
  "proceed",
  "seed",
  "speed",
  "spring",
  "string",
  "succeed",
  "swing",
]);
/** Commands that exit 0 whatever happened: atask refuses them as proofs ("no-op ... cannot fail"). */
const NO_OP_COMMAND = /^(?:echo|printf|true|false|:|exit\s+0|sleep\s+\d+)(?:\s|$)/;

const normalized = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Why `title` is not one atask takes: empty, too long, several lines, or not an imperative sentence. */
export function titleProblems(title: string): string[] {
  const text = title.trim();
  if (text === "") return ["title is empty"];
  const problems: string[] = [];
  if (text.length > MAX_TITLE_LENGTH) {
    problems.push(`title is ${text.length} characters; keep it to ${MAX_TITLE_LENGTH}`);
  }
  if (/[\r\n]/.test(text)) problems.push("title must be one line");
  if (!/^[A-Za-z]/.test(text)) problems.push("title must start with a verb");
  const lead = text.split(/\s+/)[0]!.toLowerCase();
  const inflected = lead.length >= MIN_INFLECTED_LENGTH && INFLECTED_ENDING.test(lead)
    && !IMPERATIVES_ENDING_INFLECTED.has(lead);
  if (NON_IMPERATIVE_LEAD.has(lead) || inflected) {
    problems.push(`title must be imperative ("Fix the DNS record"), not "${text.split(/\s+/)[0]}..."`);
  }
  return problems;
}

/** Why `check` is not something `atask add --proof/--regression` takes; empty when it is. `label` names it in the reasons. */
function checkProblems(label: string, check: string, asProof: boolean): string[] {
  const text = check.trim();
  const shape = CHECK_SHAPE.exec(text);
  if (shape === null) return [`${label} must be "run: <command>" or "<preset>: <subject>"`];
  const [, preset, rest] = shape as unknown as [string, string, string];
  if (!(CHECK_PRESETS as readonly string[]).includes(preset)) {
    return [`${label} preset "${preset}" is not one of: ${CHECK_PRESETS.join(", ")}`];
  }
  const subject = rest.trim();
  if (subject === "" && SUBJECT_REQUIRED.has(preset)) return [`${label} "${preset}:" needs a subject after the colon`];
  if (subject !== "" && NO_SUBJECT_ALLOWED.has(preset)) {
    return [`${label} "${preset}" takes no subject: write "${preset}:" alone, not "${preset}: ${subject}"`];
  }
  if (/[\r\n\0]/.test(subject)) return [`${label} must be one line`];
  if (preset === RUN_PRESET && NO_OP_COMMAND.test(subject)) {
    return [`${label} command "${subject}" cannot fail, so it proves nothing: run a command that checks the outcome`];
  }
  if (asProof && preset === "go_test" && !/(?:^|\s)name=\S/.test(subject)) {
    return [`${label} go_test must finish in 30 seconds: add name=REGEX to run one test ("go_test: ./pkg name=TestX")`];
  }
  return [];
}

/**
 * Everything wrong with a model-written task spec (and, given the project's `context`, with what it names), in words for the model; empty when `atask add` will take it.
 * atask has no dry-run validation, so this is its documented grammar plus the refusals it was seen to make:
 * unknown presets, empty subjects, commands that cannot fail, and a small proof over a whole tree.
 */
export function taskSpecProblems(spec: TaskSpec, context?: ProjectContext): string[] {
  const problems = [...titleProblems(spec.title)];
  problems.push(...checkProblems("proof", spec.proof, true), ...checkProblems("regression", spec.regression, false));
  problems.push(...regressionProblems(spec.regression));
  if (context !== undefined) problems.push(...groundedSpecProblems(spec, context));
  if (normalized(spec.proof) === normalized(spec.regression)) {
    problems.push(
      "proof and regression must differ: the proof shows this task works, the regression that nothing else broke",
    );
  }
  if (!(CHECK_SIZES as readonly string[]).includes(spec.size)) {
    problems.push(`size "${spec.size}" must be one of ${CHECK_SIZES.join(", ")}`);
  }
  if (spec.rationale.trim() === "") problems.push("rationale is empty");
  return problems;
}
