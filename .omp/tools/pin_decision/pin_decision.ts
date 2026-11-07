import {
  alreadyAnsweredReason,
  enforceAskGate,
  formatAlreadyAnsweredError,
  type GateOutcome,
} from "./ask_gate.js";
import type { ModelStep } from "./omp_model.js";
import { pinText } from "./render.js";
import { decisionsDirectory, findDuplicate, MAX_HOTKEYS, pinDecision } from "./store.js";

export interface PinInput {
  question: string;
  options: string[];
  /** The band the pin joins; the caller resolves the default (this omp session) before calling. */
  session: string;
  /** This session's earlier user messages, newest last; enables the deterministic already-answered check. */
  earlier_user_messages?: string[];
}

export interface PinOutput {
  id: number;
  question: string;
  options: string[];
  session: string;
  /** The pin as plain text, for a harness with no decision band. */
  text: string;
  /** How the ask gate ended: `passed`, or `unavailable` (the judge could not run; the pin was made without it). */
  ask_gate: GateOutcome;
}

export interface PinDeps {
  step: ModelStep;
  signal?: AbortSignal;
  /** Where session files live; default from the environment. */
  directory?: string;
}

/** Throws, naming the field, for an input the band cannot show. */
export function validatePin(input: PinInput): void {
  if (input.question.trim() === "" || /[\r\n]/.test(input.question)) throw new Error("question must be one non-empty line");
  if (input.options.length < 1 || input.options.length > MAX_HOTKEYS) {
    throw new Error(`options must hold 1 to ${MAX_HOTKEYS} choices (one hotkey each), got ${input.options.length}`);
  }
  if (input.options.some((option) => option.trim() === "")) throw new Error("an option must not be empty");
  if (input.session.trim() === "") throw new Error("session must not be empty");
}

/**
 * Pins one decision for the human and returns at once. In order: the deterministic already-answered check (when
 * `earlier_user_messages` is given), a refusal of a question the session already holds (no model spent on a repeat),
 * the ask gate (one model call), then the write. Each refusal throws as the answer; nothing is pinned.
 */
export async function pin(input: PinInput, deps: PinDeps): Promise<PinOutput> {
  validatePin(input);
  const directory = deps.directory ?? decisionsDirectory();
  if (input.earlier_user_messages !== undefined) {
    const answered = alreadyAnsweredReason(input.question, input.earlier_user_messages);
    if (answered !== undefined) throw new Error(formatAlreadyAnsweredError(answered));
  }
  const repeat = await findDuplicate(directory, input.session, input.question);
  if (repeat !== undefined) throw repeat;
  const gate = await enforceAskGate({ question: input.question, options: input.options }, deps.step, deps.signal);
  deps.signal?.throwIfAborted();
  const pinned = await pinDecision(directory, input.session, input.question, input.options);
  return {
    id: pinned.id,
    question: pinned.question,
    options: [...pinned.options],
    session: input.session,
    text: pinText(pinned),
    ask_gate: gate,
  };
}
