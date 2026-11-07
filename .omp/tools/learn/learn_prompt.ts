import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** What `learn` needs to know of one reviewed session; the shape `extract_hypotheses` returns. */
export interface Reviewed {
  conversation: string;
  annotated_path: string;
  review_path: string;
  report_markdown?: string;
}

/** `# Shared operating instructions` and `~/.agents/AGENTS.md` as they are now, the opening of every message the loop sends. */
export async function sharedInstructions(home: string = homedir()): Promise<string> {
  const shared = await readFile(join(home, ".agents", "AGENTS.md"), "utf8").catch(() => "");
  return ["# Shared operating instructions", "", shared].join("\n");
}

/**
 * Zach's ask, from the session that designed this loop ("We're currently trying to self-improve the AI tooling in
 * Mastra and local harnesses on this machine. An analysis of another conversation was already run and the results
 * are below. Please review those results and implement the changes suggested…"), tightened once by the prompt-writer
 * agent with its meaning kept; "below" became the two file paths that follow it.
 */
export const APPLY_ASK = [
  "We are self-improving the AI tooling in Mastra and the local harnesses on this machine. An analysis of another conversation was already run; its results are in the review file named below, and the annotated transcript it was written from is beside it.",
  "",
  "1. Review the results and implement the changes they suggest.",
  "2. Work through each suggestion systematically, using subagents if needed.",
  "3. Before writing any configuration file, check its syntax so you don't break anything accidentally.",
  "4. If you're worried about the safety of a change, run an experiment in Mastra and promote it to live depending on the result.",
  "5. The code-improver subagent (the `agent-code-improver` tool) is suggested for implementing changes while you supervise, but you can make the changes yourself if that's easier.",
  "6. Completion means a clean result: every file you touched is either git-tracked and committed (up to date) or not git-tracked at all.",
  "7. While something may need an experiment, all experiments need to be run at the end. Any finding that has not been implemented will be permanently ignored, and by leaving it you are asserting that you believe there is no value in implementing it.",
].join("\n");

/** The message the applier gets: the shared instructions, Zach's ask, then the two files on disk. */
export async function applyPrompt(review: Reviewed, home: string = homedir()): Promise<string> {
  return [
    await sharedInstructions(home),
    "",
    APPLY_ASK,
    "",
    `Review (the results): ${review.review_path}`,
    `Annotated transcript it was written from: ${review.annotated_path}`,
  ].join("\n");
}

/** The learning-applier agent's instructions (the `Prompt` of its Mastra definition), shipped beside this tool. */
export async function applierInstructions(): Promise<string> {
  return readFile(new URL("./prompts/learning_applier.md", import.meta.url), "utf8");
}

/** What the full omp session receives: the applier's instructions as the system-style preamble, then the apply message. */
export async function sessionPrompt(review: Reviewed, home: string = homedir()): Promise<string> {
  const instructions = await applierInstructions();
  return [instructions.trimEnd(), "", "---", "", await applyPrompt(review, home)].join("\n");
}
