/**
 * The four judgments orient asks of a model about one range of code. Each is a yes/no question answered as a
 * probability. The instructions are the text Mastra's decision model was given, unchanged.
 */

export interface NoulQuestion {
  readonly field: string;
  readonly instructions: string;
  /** What a yes and a no mean. */
  readonly criteria: { readonly yes: string; readonly no: string };
}

export const SEAM: NoulQuestion = {
  field: "Seam",
  instructions: [
    "You are verifying one range of a file against a behavior a developer wants to change.",
    "The range is shown verbatim, as read from disk just now, with its line numbers.",
    "",
    "Answer yes when these lines implement the described behavior or a central part of it:",
    "lines a developer changing that behavior would have to edit. A behavior described in",
    "several steps is implemented by the range that performs any one of those steps. Answer",
    "no when the lines only share vocabulary with the behavior, only declare types or",
    "imports, only call into the behavior from elsewhere, or are an unrelated branch.",
  ].join("\n"),
  criteria: {
    yes: "These lines implement the described behavior or a central part of it.",
    no: "These lines do not implement any part of the described behavior.",
  },
};

export const STATE: NoulQuestion = {
  field: "State",
  instructions: [
    "You are verifying one range of a file against a behavior a developer wants to change.",
    "The range is shown verbatim, as read from disk just now, with its line numbers.",
    "",
    "Answer yes when these lines hold, resolve, store, or pass in state the behavior reads or",
    "writes: an identity (session, user, request id), a configuration value, a storage path,",
    "a cache, or a shared constant the behavior depends on. Answer no when the lines are the",
    "behavior's own logic, or are unrelated to it.",
  ].join("\n"),
  criteria: {
    yes: "These lines hold or resolve state the behavior depends on.",
    no: "These lines do not hold or resolve state the behavior depends on.",
  },
};

export const ANSWER: NoulQuestion = {
  field: "Answer",
  instructions: [
    "You are verifying one range of a file against a specific question about a codebase.",
    "The range is shown verbatim, as read from disk just now, with its line numbers.",
    "",
    "Answer yes when these lines answer the question: they are the code the question asks",
    "about. Answer no when the lines only share vocabulary with the question.",
  ].join("\n"),
  criteria: { yes: "These lines answer the question.", no: "These lines do not answer the question." },
};

export const TEST: NoulQuestion = {
  field: "Test",
  instructions: [
    "You are verifying one range of a test file against a behavior a developer wants to",
    "change. The range is shown verbatim, as read from disk just now, with its line numbers.",
    "",
    "Answer yes when this test exercises the described behavior: it would fail if the",
    "behavior broke. Answer no when the test covers something else, or only sets up fixtures.",
  ].join("\n"),
  criteria: {
    yes: "This test exercises the described behavior.",
    no: "This test does not exercise the described behavior.",
  },
};
