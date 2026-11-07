import { conversationRefOf } from "./conversation_ref.js";
import { type HostMachine, osHostMachine } from "./host_machine.js";
import { readTranscript } from "./read_transcript.js";
import { harnessOf } from "./schemas.js";
import type { Transcript } from "./schemas.js";

export interface ReadTurnsOptions {
  /** Keep the `tool` turns (a tool call and its result). Off, the turns are only what a conversation reads. */
  readonly toolCalls?: boolean;
}

/** Where a conversation's transcript comes from. The tool depends on this and on nothing else that reads a machine. */
export interface TurnSource {
  /**
   * The conversation's normalized turns, oldest first, the path or database they came from and how many lines were
   * skipped. Throws, naming the ref, when there is no such conversation.
   */
  readTurns(conversation: string, options?: ReadTurnsOptions): Promise<Transcript>;
}

/** The default `TurnSource`: the transcript files and databases of this machine. */
export function transcriptFilesTurnSource(machine: HostMachine = osHostMachine()): TurnSource {
  return {
    async readTurns(conversation, options = {}) {
      const ref = conversationRefOf(conversation);
      const harness = harnessOf(ref);
      return readTranscript(harness, ref.slice(harness.length + 1), machine, options);
    },
  };
}
