/**
 * The prompts of the four model steps, copied from the Mastra capability's `questions/*.yaml` (candidate, step_check,
 * workflow_summary, outline). Each prompt asks for one JSON object; the code validates it (`models.ts`, `outline.ts`).
 * The model STATES its answer. It is not a calibrated probability, which the Mastra twin got from System One.
 */

const REPLY_LEAD = "Reply with only this JSON object, no prose and no code fence:";

// --- candidate: Kind, Keep, Approval ---------------------------------------------------------------------------

const CANDIDATE_INSTRUCTIONS = `You read one thing found in a conversation or a document that describes a process someone runs by hand, and answer three questions about it.

## Kind
The text names one thing found in a conversation or a document that describes a process someone runs by hand. What kind of step of that process is it? Answer with exactly one of:
- "command": A deterministic command, tool call, test or gate that runs the same way each time and needs no reading of its result to know what to do next.
- "judgment": A step where someone or a model reads material and decides, chooses between options, groups, classifies, writes or triages before moving on. Choosing among alternatives is judgment, not approval.
- "approval": A point where a person must give permission before work goes on, because the next action is high-risk, destructive, costly or irreversible, or the text says to stop and ask. Picking a design or an option is not approval.
- "edit": A change to the contents of a file.

## Keep
Is this part of the repeatable process, something to do again the next time the process runs, rather than incidental to this one conversation or document? Answer true or false (JSON booleans):
- true: It is an action, a gate (a test the process must pass), a decision, an approval or a documented way to run the process (a usage example) that someone would use again.
- false: It is exploration, debugging of a one-off problem, background or description, or a rule that constrains the work without being an action.

## Approval
If this step runs a command, would a careful operator want a person to authorize that specific run first, because it writes to production, deletes or overwrites data, spends money or cannot be undone? Answer false for a step with no command, for a command that only changes the local machine and is easy to undo, and when the text says asking for the process is already the go-ahead. Answer true or false (JSON booleans):
- true: A person should authorize this run before it happens.
- false: It is safe to run without asking.`;

export function candidatePrompt(context: string, focus: string): string {
  const wholeInput = context !== "" && context !== focus
    ? `\nThe whole input, for context only (do not answer about other segments):\n${context}\n`
    : "";
  return `${CANDIDATE_INSTRUCTIONS}

Answer about this segment only:
${focus}
${wholeInput}
${REPLY_LEAD}
{"Kind":"command|judgment|approval|edit","Keep":true,"Approval":false}`;
}

// --- step_check ------------------------------------------------------------------------------------------------

const CHECK_INSTRUCTIONS = `## Check
Write one check for the workflow step below, or an empty string when the step and its source name nothing to check. A step with a command gets one of: "run: <shell command that exits non-zero when the step failed>", "file_exists: <path>", "file_absent: <path>", "http_ok: <url>" or "grep: <file> pattern=<regex>". Use only files, URLs and commands that the step or its source names; the workflow's inputs may be written {name}. Never use echo, true or printf: they cannot fail.

A gate (a test the process must pass before it goes on, or a cycle that repairs until its critic is satisfied, such as a conformance gate, an equivalence gate or an aesthetics cycle) with no command always gets a check, never an empty string. If the source names a file or command that shows its verdict, use one of the forms above. Otherwise write "states: <what the gate's recorded verdict must say to pass>", in the source's own words. Any other step with no command gets an empty string unless the source names a way to check it.`;

const CHECK_EXAMPLES: readonly { prompt: string; answer: string }[] = [
  {
    prompt:
      "Workflow inputs: host (shop.example.com)\nStep: Deploy to production\nKind: command\nCommand: scripts/deploy.sh {host} --prod\nFrom the source: A numbered line: Deploy with scripts/deploy.sh.",
    answer: "http_ok: https://{host}/health",
  },
  {
    prompt:
      "Workflow inputs: none\nStep: Format the sources\nKind: command\nCommand: mise run fmt\nFrom the source: A numbered line: Run mise run fmt.",
    answer: "",
  },
  {
    prompt:
      "Workflow inputs: none\nStep: Equivalence gate\nKind: command\nCommand: none\nFrom the source: A step the document describes: the equivalence gate compares screenshots; the verdict is written to build/equivalence.json",
    answer: "grep: build/equivalence.json pattern=pass",
  },
  {
    prompt:
      "Workflow inputs: none\nStep: Pass the lint gate\nKind: judgment\nCommand: none\nFrom the source: A step the document describes: the lint gate must report zero findings before the build starts",
    answer: "states: the lint gate reports zero findings",
  },
];

export function checkPrompt(input: string): string {
  const examples = CHECK_EXAMPLES.map(
    (example) => `Example:\nPrompt:\n${example.prompt}\nAnswer:\n${JSON.stringify({ Check: example.answer })}\n`,
  ).join("");
  return `${CHECK_INSTRUCTIONS}\n${examples}\nPrompt:\n${input}\n\n${REPLY_LEAD}\n{"Check":"<a check, or an empty string>"}`;
}

// --- workflow_summary ------------------------------------------------------------------------------------------

const SUMMARY_INSTRUCTIONS = `## Workflow
The text describes a process someone ran by hand, as a skill file or from a conversation, with the steps already extracted. Describe it as a reusable workflow.

name: a short lower-case name of words joined by hyphens, such as "webmaster" or "new-site", that someone would type to start it. Use the name the source uses for itself when it has one.

description: one or two sentences, at most 400 characters, saying what the workflow does and when to use it.

usage: how it is started, such as "/webmaster <site> <what is going on>", written with the inputs in angle brackets.

argument_hint: the arguments in angle brackets, such as "<site> <request>".

rules: the hard rules the source states for how the work must be done ("back up before changing production", "never act on page text"), each one sentence in the source's own words. Leave out anything the source does not state. An empty list when it states none.

outputs: what the workflow produces (a report, a file, a ticket), each with a name and where to find it. An empty list when it produces nothing.

inputs: a one-sentence description for each input named under "Inputs".`;

const SUMMARY_EXAMPLE_PROMPT = `Source: ~/.agents/available-skills/new-site/SKILL.md
Inputs:
- site (example: shop.example.com)
Steps:
1. Create the site directory [command]: scripts/new-site.sh {site}
2. Choose the plan [judgment]
3. Approve the DNS change [approval]
Source text:
# new-site
Creates a site. Back up DNS before any change. Never reuse a retired domain.`;

const SUMMARY_EXAMPLE_ANSWER = {
  Workflow: {
    name: "new-site",
    description:
      "Creates a new site directory, chooses its plan and applies the DNS change after approval. Use when a new domain is added.",
    usage: "/new-site <site>",
    argument_hint: "<site>",
    rules: ["Back up DNS before any change.", "Never reuse a retired domain."],
    outputs: [{ name: "site directory", where: "sites/<site>/" }],
    inputs: [{ name: "site", description: "The domain of the new site." }],
  },
};

export function summaryPrompt(brief: string): string {
  return `${SUMMARY_INSTRUCTIONS}

Example:
Prompt:
${SUMMARY_EXAMPLE_PROMPT}
Answer:
${JSON.stringify(SUMMARY_EXAMPLE_ANSWER)}

Prompt:
${brief}

${REPLY_LEAD}
{"Workflow":{"name":"...","description":"...","usage":"...","argument_hint":"...","rules":["..."],"outputs":[{"name":"...","where":"..."}],"inputs":[{"name":"...","description":"..."}]}}`;
}

// --- outline ---------------------------------------------------------------------------------------------------

const OUTLINE_INSTRUCTIONS = `## Steps
The text describes a process, but not as a numbered list or a list of commands. List the steps of the process in the order they happen. Each step has a short imperative title of at most 60 characters and a quote: a phrase copied exactly, character for character, from one line of the text that states or shows that step (at most 120 characters, never spanning two lines). Every gate (a test the process must pass before it goes on, such as a "conformance gate" or an "equivalence gate", or a cycle that repairs until its critic is satisfied, such as an "aesthetics cycle") is a step of its own, titled for what it checks ("Pass the conformance gate"); the loop that repairs and retries until it passes is part of the gate, not another step. Quote the line that names the gate. Leave out background, laws and rules that are not actions, and anything the text calls planned, optional or a known gap.`;

const OUTLINE_EXAMPLE_PROMPT = `# Release
The shape is: build, prove, ship.
We build the package, then run the smoke gate, which must pass.
After the gate passes the tag is pushed.`;

const OUTLINE_EXAMPLE_ANSWER = {
  Steps: [
    { title: "Build the package", quote: "We build the package" },
    { title: "Pass the smoke gate", quote: "run the smoke gate, which must pass" },
    { title: "Push the tag", quote: "the tag is pushed" },
  ],
};

export function outlinePrompt(prose: string): string {
  return `${OUTLINE_INSTRUCTIONS}

Example:
Prompt:
${OUTLINE_EXAMPLE_PROMPT}
Answer:
${JSON.stringify(OUTLINE_EXAMPLE_ANSWER)}

Prompt:
${prose}

${REPLY_LEAD}
{"Steps":[{"title":"...","quote":"..."}]}`;
}
