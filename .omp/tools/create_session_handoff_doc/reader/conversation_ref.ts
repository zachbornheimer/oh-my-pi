import { CONVERSATION_LOOKUP, CONVERSATION_LOOKUP_MESSAGE } from "./schemas.js";

/** A chat thread's page in Mastra Studio, `https://<host>/agents/<agentId>/threads/<threadId>`. */
const MASTRA_THREAD_URL = /^https?:\/\/[^\s/?#]+\/agents\/[^\s/?#]+\/threads\/([^\s/?#:]+)\/?(?:[?#]\S*)?$/;
const MASTRA_THREAD_REF = /^mastra:thread:[^\s:]+$/;

/** True when `input` (a ref or a Studio URL) names a Mastra chat thread. This tool cannot read one: it holds no Mastra trace store. */
export const namesMastraThread = (input: string): boolean => MASTRA_THREAD_REF.test(input) || MASTRA_THREAD_URL.test(input);

/**
 * The conversation ref `input` names: a `<harness>:<identifier>` ref as it is. Throws, naming the accepted form, for
 * anything else (a bare id, a URL), and says so when the input is a Mastra chat thread, which this tool cannot read.
 */
export function conversationRefOf(input: string): string {
  if (namesMastraThread(input)) {
    throw new Error(`transcript: "${input}" is a Mastra chat thread; this tool reads harness session files and databases only, not Mastra's stored traces`);
  }
  if (CONVERSATION_LOOKUP.test(input)) return input;
  throw new Error(`transcript: "${input}" is not a conversation ref; it ${CONVERSATION_LOOKUP_MESSAGE}`);
}
