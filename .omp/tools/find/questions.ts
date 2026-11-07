/**
 * The two judgments find asks of a model: whether a file plausibly holds the behavior, and whether one passage leads
 * to it. Each is a yes/no question answered as a probability. The instructions are the text Mastra's decision model was
 * given, unchanged.
 */

export interface NoulQuestion {
  readonly field: string;
  readonly instructions: string;
  /** What a yes and a no mean. */
  readonly criteria: { readonly yes: string; readonly no: string };
}

export const FILE: NoulQuestion = {
  field: "File",
  instructions: [
    "You are judging a code search. The query below describes a behavior, and the file named",
    "in this question is one candidate from a lexical pre-scan.",
    "",
    "Answer yes when this file plausibly implements or contains the described behavior, even if",
    "only part of it lives here. Answer no when the file only mentions the words incidentally,",
    "is a test fixture for something else, or is unrelated.",
    "",
    "Do not reward a file merely because its name repeats the query words.",
  ].join("\n"),
  criteria: {
    yes: "The file plausibly implements or contains the described behavior.",
    no: "The file does not implement or contain the described behavior.",
  },
};

export const PASSAGE: NoulQuestion = {
  field: "Passage",
  instructions: [
    "You are verifying one passage of a file against a code search query. The passage is shown",
    "verbatim; the line range names where it sits in the file.",
    "",
    "Answer yes when reading this passage would lead a developer to the implementation of the",
    "described behavior. Answer no when the passage only shares vocabulary with the query, or",
    "when it is boilerplate, imports, types, or an unrelated branch.",
  ].join("\n"),
  criteria: {
    yes: "This passage implements or directly leads to the described behavior.",
    no: "This passage does not implement or lead to the described behavior.",
  },
};
