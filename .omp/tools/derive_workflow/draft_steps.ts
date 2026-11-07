import { type Candidate, cleanTitle } from "./candidates.ts";
import { commandLabel } from "./commands.ts";
import type { Evidence, FailurePolicy, StepKind } from "./schemas.ts";

/** What the decision model said about a candidate. */
export interface Decision {
  readonly kind: StepKind;
  /** True when the candidate is part of the repeatable process rather than incidental to this one source. */
  readonly keep: boolean;
  /** True when a person should authorize the candidate's command before it runs. */
  readonly approval: boolean;
}

/** A step before its inputs are named and its check written. */
export interface StepDraft {
  readonly key: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly run?: string;
  readonly requires: string[];
  readonly on_failure: FailurePolicy;
  readonly evidence: readonly Evidence[];
  /** What the source says about the step: the words the check is written from. */
  readonly basis: string;
}

export interface Drafts {
  readonly steps: StepDraft[];
  /** Candidates the model judged incidental to the one source. */
  readonly incidental: number;
}

const KEY_SEPARATOR = /[^a-z0-9]+/g;
const FALLBACK_KEY = "step";
const MAX_KEY_LENGTH = 40;

/** `Deploy to production` -> `deploy_to_production`, unique among `taken` (`_2`, `_3`, ...). */
export function uniqueKey(title: string, taken: ReadonlySet<string>): string {
  const whole = title.toLowerCase().replace(KEY_SEPARATOR, "_").replace(/^_+|_+$/g, "");
  const atWord = whole.lastIndexOf("_", MAX_KEY_LENGTH);
  const slug = whole.length <= MAX_KEY_LENGTH ? whole : whole.slice(0, atWord > 0 ? atWord : MAX_KEY_LENGTH);
  const base = /^[a-z]/.test(slug) ? slug : `${FALLBACK_KEY}_${slug}`.replace(/_$/, "");
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base}_${number}`)) number += 1;
  return `${base}_${number}`;
}

/** The kind the source settles, if it does: an edit is an edit, a command that is only a command is a command. */
function settledKind(candidate: Candidate): StepKind | undefined {
  if (candidate.edit !== undefined) return "edit";
  return candidate.commandOnly ? "command" : undefined;
}

const failurePolicy = (kind: StepKind, retried: boolean): FailurePolicy =>
  kind !== "command" ? "ask" : retried ? "retry_once" : "stop";

/**
 * The steps of the kept candidates, in order, each requiring the one before. The model's kind is used only where the
 * source does not settle it. A line that is not only a command but carries one ("group the findings, then run X") is
 * two steps: the judgment, approval or edit, then the command.
 */
export function draftSteps(candidates: readonly Candidate[], decisions: readonly Decision[]): Drafts {
  const steps: StepDraft[] = [];
  const taken = new Set<string>();
  let incidental = 0;
  const push = (title: string, kind: StepKind, candidate: Candidate, run?: string): void => {
    const key = uniqueKey(title, taken);
    taken.add(key);
    steps.push({
      key,
      title,
      kind,
      ...(run === undefined ? {} : { run }),
      requires: steps.length === 0 ? [] : [steps.at(-1)!.key],
      on_failure: failurePolicy(kind, candidate.retried),
      evidence: candidate.evidence,
      basis: candidate.text,
    });
  };
  candidates.forEach((candidate, index) => {
    const decision = decisions[index]!;
    if (!decision.keep) {
      incidental += 1;
      return;
    }
    const kind = settledKind(candidate) ?? decision.kind;
    if (candidate.command === undefined) {
      push(candidate.title, kind === "command" ? "judgment" : kind, candidate);
      return;
    }
    const approves = decision.approval && kind !== "approval";
    if (kind === "command") {
      if (approves) push(cleanTitle(`Approve ${candidate.title}`), "approval", candidate);
      push(candidate.title, "command", candidate, candidate.command);
      return;
    }
    push(candidate.title, kind, candidate);
    if (approves) push(cleanTitle(`Approve running ${commandLabel(candidate.command)}`), "approval", candidate);
    push(cleanTitle(`Run ${commandLabel(candidate.command)}`), "command", candidate, candidate.command);
  });
  return { steps, incidental };
}
