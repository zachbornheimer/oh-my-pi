/**
 * One turn of a Linear agent session, as the caller hands it in: `user` for anything the human sent (a prompt, or a
 * comment posted while a run was live), `agent` for what a run answered. Roles need not alternate: a user turn no
 * agent turn follows was never answered.
 */
export interface ThreadTurn {
  readonly role: "user" | "agent";
  readonly text: string;
}

/** Oldest first. */
export type Thread = readonly ThreadTurn[];

/** Validates a handed-in thread: a list of `{ role: user | agent, text }` with non-empty text and no other keys. Throws on a bad shape. */
export function parseThread(value: unknown): Thread {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("thread must be a list of { role, text } turns");
  return value.map((turn: unknown, index) => {
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) throw new Error(`thread[${index}] must be an object`);
    const keys = Object.keys(turn);
    const { role, text } = turn as Record<string, unknown>;
    if (keys.some((key) => key !== "role" && key !== "text")) throw new Error(`thread[${index}] has keys other than role and text`);
    if (role !== "user" && role !== "agent") throw new Error(`thread[${index}].role must be "user" or "agent"`);
    if (typeof text !== "string" || text === "") throw new Error(`thread[${index}].text must be a non-empty string`);
    return { role, text };
  });
}

/** What a stub prompt stands for in the thread: the assignment is the ticket's own content, which the run is handed anyway. */
export const TICKET_ITSELF = "The ticket itself (its title and description, above).";

/**
 * A prompt that adds nothing to the ticket it names: Linear's own `Work on [ZYS-7383](https://linear.app/…)` for a
 * delegated issue carries no assignment, and the receiver's `Delegated to Relay: ZYS-7383 - <title>` form is the ticket's
 * own title and description. Either way the ticket the run is handed is the assignment.
 */
export function isTicketStub(prompt: string, identifier: string): boolean {
  const ident = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = prompt.trim();
  return new RegExp(`^(?:work on\\s+)?(?:\\[[^\\]]*${ident}[^\\]]*\\](?:\\([^)]*\\))?|${ident})[\\s.!]*$`, "i").test(text)
    || new RegExp(`^delegated to relay:\\s*${ident}\\b`, "i").test(text);
}

/** A turn as a run reads it: this turn's instruction (absent for a first turn) and the turns before it. */
export interface ResolvedTurn {
  readonly prompt?: string;
  readonly thread: Thread;
}

/**
 * The one place a handed-in turn becomes what the session reads:
 * - the instruction is `prompt`, else the thread's last user turn (taken out of the thread, never shown twice; one that
 *   repeats `prompt` is dropped likewise);
 * - a stub prompt is no instruction, and a stub in the thread reads as the ticket itself.
 * The newest turn is not assumed to be the instruction by anything else: earlier user turns stay in the thread.
 */
export function resolveTurn(turn: { readonly prompt?: string; readonly thread: Thread }, identifier: string): ResolvedTurn {
  const newest = turn.thread.at(-1);
  const lastUser = newest?.role === "user" ? newest : undefined;
  const takesInstruction = lastUser !== undefined && (turn.prompt === undefined || lastUser.text.trim() === turn.prompt.trim());
  const earlier = takesInstruction ? turn.thread.slice(0, -1) : turn.thread;
  const instruction = turn.prompt ?? lastUser?.text;
  const thread = earlier.map((entry) =>
    entry.role === "user" && isTicketStub(entry.text, identifier) ? { ...entry, text: TICKET_ITSELF } : entry
  );
  return instruction === undefined || isTicketStub(instruction, identifier) ? { thread } : { prompt: instruction, thread };
}

/**
 * The thread as plain text, oldest first, each turn under its role. A user turn no agent turn follows says so: it was
 * never answered (a comment posted while a run was live). The caller fences it as the untrusted data it is.
 */
export function threadText(thread: Thread): string {
  return thread
    .map((turn, index) => {
      const heading = `Turn ${index + 1} (${turn.role === "user" ? "user" : "agent's answer"}):\n${turn.text}`;
      const answered = thread[index + 1]?.role === "agent";
      return turn.role === "user" && !answered ? `${heading}\n(No answer was recorded for this turn.)` : heading;
    })
    .join("\n\n");
}
