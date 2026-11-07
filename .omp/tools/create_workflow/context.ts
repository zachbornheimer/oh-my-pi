import type { ModelStep } from "./omp_model.js";
import type { Machine } from "./machine.js";

/** What a model step of a run needs: the one model call, the caller's abort signal and a place to say what is happening. */
export interface StepContext {
  readonly step: ModelStep;
  readonly signal?: AbortSignal;
  readonly progress: (message: string) => void;
}

/** What `runProposeCapabilities` is given besides the input. */
export interface ProposeDeps {
  /** One model call: the tool's own `omp -p` step, or a fake in tests. */
  readonly step: ModelStep;
  /** The filesystem the gatherers read: files, folders and the directory of installed omp tools. */
  readonly machine: Machine;
  /** Reads the turns of a conversation `<harness>:<identifier>`; default: the harnesses' own session stores under the home directory. */
  readonly readConversation?: ConversationReader;
  readonly signal?: AbortSignal;
  /** Called with a short line whenever a model step starts or finishes. */
  readonly onProgress?: (message: string) => void;
}

/** One turn of a conversation, as the digest reads it: what a person asked, what the agent said, or a tool the agent called. */
export interface Turn {
  readonly role: "user" | "agent" | "tool";
  readonly text: string;
  readonly tool_call?: { readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };
}

export type ConversationReader = (harness: string, identifier: string, signal?: AbortSignal) => Promise<Turn[]>;
