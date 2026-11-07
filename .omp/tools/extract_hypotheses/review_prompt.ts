import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `# Shared operating instructions` and `~/.agents/AGENTS.md` as they are now, the opening of every message the loop sends. */
export async function sharedInstructions(home: string = homedir()): Promise<string> {
  const shared = await readFile(join(home, ".agents", "AGENTS.md"), "utf8").catch(() => "");
  return ["# Shared operating instructions", "", shared].join("\n");
}

/**
 * The message Zach sent in omp session 01a1604d, verbatim: the shared operating instructions, then the ask with the
 * export's path filled in. The forensics agent's own instructions are the analyst prompt that message carried.
 */
export async function reviewPrompt(path: string, home: string = homedir()): Promise<string> {
  return [
    await sharedInstructions(home),
    "",
    `Here's a transcript to review: ${path}`,
    "",
    "It's a large transcript.",
    "",
    "I'd like an extensive set of learnings - things we can do in the future to help improve agent performance. Anything that touches multiple agents (meaning AGENTS.md, skill rewrites, tool removals, etc) will go thru standard evidentiary procedure and will be included if their scorers deem the experiment a success. But, first, we need to know what we should look at.",
    "",
    "After you go thru your standard prompt workings, adversarially review this transcript. Turn by turn. If we had ____, we could have skipped X steps, if we disabled parallel reads for the first 3 turns we'd save X tokens (you can estimate with `echo \"Hello, World\" | tokuin --model gpt-4` via the run_command tool if needed). What I want is an extensive list of options - some may compete, eg:",
    "",
    "\" A tool or skill that does ___.\"",
    "That implies that experimentation should be done or both should be done if there's no consequence (which we don't put tool names and descriptions into context without semantic filtering first).",
    "",
    "If we implement all of your suggestions, things get meaningfully better for all agents in Mastra and on my machine.",
  ].join("\n");
}

/** The Execution Forensics agent's instructions (the `Prompt` of its Mastra definition), shipped beside this tool. */
export async function forensicsInstructions(): Promise<string> {
  return readFile(new URL("./prompts/execution_forensics.md", import.meta.url), "utf8");
}

/**
 * What the full omp session receives: the forensics agent's instructions as the system-style preamble, then the
 * review message (shared instructions, the ask, the export's path).
 */
export async function sessionPrompt(path: string, home: string = homedir()): Promise<string> {
  const instructions = await forensicsInstructions();
  return [instructions.trimEnd(), "", "---", "", await reviewPrompt(path, home)].join("\n");
}
