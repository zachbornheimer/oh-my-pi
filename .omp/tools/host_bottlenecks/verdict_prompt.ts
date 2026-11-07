import { REMEDIES, VERDICTS } from "./types.ts";

/** What the model is told when the rules could not settle a family. Kept as data so a test can read it. */
export const VERDICT_INSTRUCTIONS = `Process families on a Mac were measured and the rules could not settle them. Each family is one root process and everything it started. For each family decide whether the load it puts on the computer is normal, or whether it can be made less painful.

verdict: "normal" when the work is what the program is for and cannot be reduced (an editor, a database, a browser doing its job). "overscoped" when a hook, formatter, linter or test is doing more than the change needs, such as the whole repository instead of the changed files. "runaway" when too many copies run, or something runs that nothing is driving. "contention" when the family is fine alone but competes with other heavy work at the same time, including a VM whose containers together demand more CPU cores than the VM is configured with. "unknown" when the evidence does not say.

remedy: exactly one of ${REMEDIES.join(", ")}. Use none for normal. Never invent another remedy.

advice: one sentence a person acts on. Name the program and, when the evidence gives one, the repository. Give a command only when the evidence makes it exact (for stale work, "kill <pids>" with the listed pids). The command is only advice; nothing runs it.

confidence: a number from 0 to 1 for how sure the evidence makes you.

Answer once for every family listed, using its root_pid exactly as written. Judge only from the evidence given.`;

export const VERDICT_EXAMPLES: readonly { readonly prompt: string; readonly answer: unknown }[] = [
  {
    prompt: [
      "Host: load 0.4 per core (4 cores).",
      "Family root_pid 812: name=python3, kind=other, cpu=2.0%, rss=4100 MB, 1 process(es), age=3 h, started by: none, ancestry: zsh < kitty",
      "  evidence: pid 812 python3 train.py: 1 process(es), 2% cpu, 4100 MB",
    ].join("\n"),
    answer: {
      Verdicts: [{
        root_pid: 812,
        verdict: "normal",
        remedy: "none",
        advice: "A training script holding its data in memory; nothing to change.",
        confidence: 0.6,
      }],
    },
  },
  {
    prompt: [
      "Host: load 1.4 per core (10 cores).",
      "Host: VM pid 32247 Docker Desktop (image /Users/z/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw): 10 cpus, 16384 MB, containers: build 800.0% (236 MB), mysql 8.4% (413 MB).",
      "Family root_pid 32247: name=com.apple.virtualization.virtualmachine (build), kind=vm, cpu=363.2%, rss=9504 MB, 2 process(es), age=1 h, started by: launchd, ancestry: none",
      "  evidence: pid 32247 com.apple.virtualization.virtualmachine: 2 process(es), 363% cpu, 9504 MB",
    ].join("\n"),
    answer: {
      Verdicts: [{
        root_pid: 32247,
        verdict: "normal",
        remedy: "none",
        advice: "A Docker VM running one build at a time inside its 10 configured CPUs; nothing to change.",
        confidence: 0.7,
      }],
    },
  },
];

/** The JSON shape the reply must have, stated in the prompt. */
export const REPLY_SHAPE = {
  Verdicts: [
    {
      root_pid: "integer, one of the listed root_pids",
      verdict: VERDICTS.join(" | "),
      remedy: REMEDIES.join(" | "),
      advice: "string",
      confidence: "number from 0 to 1",
    },
  ],
};

/** The whole prompt: instructions, examples, the brief, then the reply shape. The model answers with JSON only. */
export function verdictPrompt(brief: string): string {
  const examples = VERDICT_EXAMPLES.map(
    (example) => `Example:\nPrompt:\n${example.prompt}\nAnswer:\n${JSON.stringify(example.answer)}\n`,
  ).join("\n");
  return [
    "## Verdicts",
    VERDICT_INSTRUCTIONS,
    "",
    examples,
    "Prompt:",
    brief,
    "",
    "Answer with only a JSON object of this shape, one entry in Verdicts for every family listed, and no other text:",
    JSON.stringify(REPLY_SHAPE),
  ].join("\n");
}
