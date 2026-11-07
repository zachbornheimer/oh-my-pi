/**
 * What each model step is asked. The instruction texts, examples and reply schemas are the question files of the Mastra
 * capability (`questions/propose.yaml`, `reconcile.yaml`, `confirm.yaml`, `pseudocode.yaml`, `registered.yaml`) as TS
 * values. Mastra asked `registered` of a decision model that answered with calibrated probabilities; here the model
 * states a plain yes/no (`{"Distinct": true|false}`).
 */

export interface Question {
  /** The one key of the reply object. */
  readonly field: string;
  readonly instructions: string;
  readonly examples: readonly { readonly prompt: string; readonly answer: unknown }[];
  /** JSON Schema of the value under `field`. */
  readonly schema: Readonly<Record<string, unknown>>;
}

const LEAF_KIND_ENUM = { type: "string", enum: ["deterministic", "model", "host"] };
const NAMES = { type: "array", minItems: 1, items: { type: "string" } };

export const PROPOSE: Question = {
  field: "Capabilities",
  instructions: [
    "The text is what was read from one source: a code folder (its docs, task runners, scripts and the names its code exports), a single file, or a conversation. Propose the capabilities someone may want to run on their own, each a leaf.",
    "A leaf is one unit of work with a clear input and a clear output that is useful by itself: a check that returns findings, a measurement, a generator, a validator, a selector, a fix that changes something. It is not a workflow (a sequence that runs other leaves in order, such as an orchestrator, a pipeline, an \"engagement\" or a \"run everything\" command), not a renderer or formatter of another leaf's result (a report, a digest, a dashboard), not an internal helper, a data type or a test, not a chore that builds, installs, lints or cleans the project itself, and not a leaf that only wraps another one, and not a step that sorts, ranks, triages or summarises the findings of another leaf. Two leaves with the same input and the same output are one leaf. Prefer fewer, distinct leaves over many overlapping ones, and propose only what the text shows; at most 30.",
    "List every leaf the text shows, not a sample. When the text enumerates what the program does (a list of capabilities, checks, commands, actions, job kinds or rules, each with its own purpose), each member someone could run on its own is a leaf, and so is each action that changes something (a fix, an update, a removal, a write) when the text lists the actions separately from the checks. Ten to thirty leaves is normal for a large folder; a single file or a conversation usually shows three to eight.",
    "name: dotted lower-case snake_case, general to specific, such as \"webmaster.page.seo\" or \"photo.duplicate.find\". Irreducible: remove any word that does not change the meaning. Complete: it names the thing and what happens to it. Clear and concise: at most 4 dotted parts. It says WHAT the leaf does or yields, never HOW: no tool, model, protocol or language words (not \"with_llm\", \"via_ssh\", \"using_regex\"). When the text names a Namespace, every name starts with it and a dot.",
    "The last word of a name is the noun it yields or a specific verb, never a filler verb that fits every capability. These last words are refused: run, check, handle, process, do, manage, execute, perform, fetch, get. Name what comes out, not that something runs: \"uptime.check\" is wrong, \"site.uptime\" is right; \"page.fetch\" is wrong, \"page.source\" is right; \"code.audit.run\" is wrong, \"code.audit\" is right. When the text lists Registered capabilities, they exist already: propose only what they lack, and never one of their names.",
    "purpose: one sentence saying what someone gets by running it.",
    "reason: one sentence saying why it deserves to be a capability: who runs it and when.",
    "input_summary and output_summary: one phrase each that names the specific thing, so two different leaves never read alike: \"the SPF, DKIM and DMARC records of a domain\" and \"mail findings\", not \"a site\" and \"findings\". input_fields and output_fields: the lower_snake_case names of the fields of its input and its output, at least one each.",
    "kind: \"deterministic\" when code alone does it, \"model\" when it needs a model's judgment or writing, \"host\" when it changes or measures something outside the program (a file, a server, a network service).",
    "evidence: one to three places in the text that show the leaf exists or is needed. For a folder or a file, a path exactly as written in the text, optionally followed by :line. For a conversation, a turn number in brackets as the text writes it, without the brackets.",
  ].join("\n"),
  schema: {
    type: "array",
    minItems: 1,
    maxItems: 30,
    items: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 48 },
        purpose: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
        input_summary: { type: "string", minLength: 1 },
        output_summary: { type: "string", minLength: 1 },
        input_fields: NAMES,
        output_fields: NAMES,
        kind: LEAF_KIND_ENUM,
        evidence: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
      },
      required: ["name", "purpose", "reason", "input_summary", "output_summary", "input_fields", "output_fields", "kind", "evidence"],
      additionalProperties: false,
    },
  },
  examples: [{
    prompt: [
      "Source: ~/Developer/photos (folder)",
      "# Documents",
      "README.md:1: # photos",
      "README.md:3: Finds duplicate photos, fixes their dates and publishes albums.",
      "# Task runners",
      "mise.toml:4: [tasks.dedupe]",
      "# Scripts",
      "scripts/publish_album.sh: Uploads an album to the gallery",
      "# Code",
      "src/dedupe.ts (3 lines)",
      "  L1 export function findDuplicates",
      "src/dates.ts (3 lines)",
      "  L1 export function fixTakenDates",
      "src/cli.ts (4 lines)",
      "  L2 .command(\"run\")",
      "  L3 export function runEverything",
    ].join("\n"),
    answer: {
      Capabilities: [
        {
          name: "photo.duplicate.find",
          purpose: "Lists groups of photos that are the same picture.",
          reason: "Someone cleaning an archive runs it before deleting anything.",
          input_summary: "a folder of photos",
          output_summary: "groups of duplicate photos",
          input_fields: ["folder"],
          output_fields: ["groups"],
          kind: "deterministic",
          evidence: ["src/dedupe.ts:1", "README.md:3"],
        },
        {
          name: "photo.date.fix",
          purpose: "Rewrites wrong taken-at dates from file names and neighbours.",
          reason: "Albums sort wrongly until dates are right; run once per import.",
          input_summary: "photos with missing or wrong dates",
          output_summary: "the corrected date for each photo",
          input_fields: ["photos"],
          output_fields: ["dates"],
          kind: "host",
          evidence: ["src/dates.ts:1"],
        },
        {
          name: "photo.album.publish",
          purpose: "Uploads an album to the gallery.",
          reason: "Someone sharing an event runs it when the album is final.",
          input_summary: "an album folder",
          output_summary: "the gallery address",
          input_fields: ["album"],
          output_fields: ["gallery_url"],
          kind: "host",
          evidence: ["scripts/publish_album.sh"],
        },
      ],
    },
  }],
};

export const RECONCILE: Question = {
  field: "Clusters",
  instructions: [
    "The same source was read by several independent samples, and each sample proposed capabilities someone may want to run. The samples agree on what the source contains but name it differently. Group the proposals by CONCEPT: proposals that give the same output from the same input are one capability, whatever their names, and the number of samples that proposed it is the evidence it is real.",
    "Return one cluster per capability:",
    "name: the one canonical name for the cluster. Dotted lower-case snake_case, general to specific, at most 4 parts and 48 characters, never saying HOW (no tool, model, protocol or language words such as with, via, using, llm, regex, ssh, cli). Irreducible: remove any word that does not change the meaning. Its last word is the noun it yields or a specific verb, never a filler verb. These last words are refused: run, check, handle, process, do, manage, execute, perform, fetch, get. Name what comes out: \"uptime.check\" is wrong, \"site.uptime\" is right; \"page.fetch\" is wrong, \"page.source\" is right; \"code.audit.run\" is wrong, \"code.audit\" is right. When a Namespace is named, the name starts with it and a dot. When Registered capabilities are listed, never use one of their names.",
    "purpose: one sentence saying what someone gets by running it.",
    "kind, input_fields, output_fields: those of the proposals it groups, the fullest of them when they differ.",
    "evidence: one to three places, taken from the evidence of its members.",
    "members: every proposal the cluster groups, each as the sample number and the proposal's name exactly as written.",
    "Rules:",
    "Every proposal belongs to at least one cluster, so none is lost.",
    "A proposal in no other sample's list still gets a cluster, of one member.",
    "Merge proposals that only differ in wording, in word order, or in how broad the name is, when they give the same output from the same input.",
    "Split a proposal whose purpose joins two jobs into two clusters, each with its own name and the same member.",
    "A capability is one unit of work, not a workflow that runs others in order and not a step that only sorts, ranks or summarises another one's findings.",
  ].join("\n"),
  schema: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 48 },
        purpose: { type: "string", minLength: 1 },
        kind: LEAF_KIND_ENUM,
        input_fields: NAMES,
        output_fields: NAMES,
        evidence: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
        members: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { sample: { type: "integer", minimum: 1 }, name: { type: "string" } },
            required: ["sample", "name"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "purpose", "kind", "input_fields", "output_fields", "evidence", "members"],
      additionalProperties: false,
    },
  },
  examples: [{
    prompt: [
      "Source: ~/Developer/photos (folder)",
      "Samples: 2",
      "Proposals:",
      "Sample 1 | photo.duplicate.find",
      "Kind: deterministic",
      "Purpose: Lists groups of photos that are the same picture.",
      "Input fields: folder",
      "Output fields: groups",
      "Evidence: src/dedupe.ts:1",
      "",
      "Sample 2 | photo.dupes.list",
      "Kind: deterministic",
      "Purpose: Lists photos that are the same picture.",
      "Input fields: folder",
      "Output fields: groups",
      "Evidence: src/dedupe.ts:1",
      "",
      "Sample 2 | photo.run",
      "Kind: host",
      "Purpose: Runs the photo tools in order.",
      "Input fields: folder",
      "Output fields: album",
      "Evidence: src/cli.ts:3",
    ].join("\n"),
    answer: {
      Clusters: [
        {
          name: "photo.duplicate.find",
          purpose: "Lists groups of photos that are the same picture.",
          kind: "deterministic",
          input_fields: ["folder"],
          output_fields: ["groups"],
          evidence: ["src/dedupe.ts:1"],
          members: [{ sample: 1, name: "photo.duplicate.find" }, { sample: 2, name: "photo.dupes.list" }],
        },
        {
          name: "photo.album",
          purpose: "Builds the album from a folder of photos.",
          kind: "host",
          input_fields: ["folder"],
          output_fields: ["album"],
          evidence: ["src/cli.ts:3"],
          members: [{ sample: 2, name: "photo.run" }],
        },
      ],
    },
  }],
};

export const CONFIRM: Question = {
  field: "Verdicts",
  instructions: [
    "Capabilities were proposed from one source. Judge each one against six criteria, then say pass or fail for it, with the criteria it fails and one line saying what is wrong.",
    "distinct: it does something none of the other proposed capabilities (and none of the Registered capabilities, when listed) does, with its own input and output. It is not a part of another one, a sequence of them, or the same one under another name.",
    "useful: someone has a clear reason to run it by itself and would use what it returns. It is not an internal helper, a data type, a formatter of another result, a test, or a step that only sorts, ranks or summarises another leaf's findings.",
    "irreducible: every word of the name carries a meaning no other word of it already carries. No word can be dropped.",
    "complete: the name alone says what is acted on and what is done or yielded, so no one has to read the description to know.",
    "clear: the name says WHAT it does or yields in plain words, never how: no tool, model, protocol or language, and no jargon a newcomer cannot read. It does not end in a filler verb such as run, check, handle, process or get.",
    "concise: a short name and a purpose that is one sentence about one thing, with no \"and\" joining two jobs.",
    "Be strict: a name that is a thing plus a vague verb, or two jobs in one capability, fails. Answer for every capability, once each, using its name exactly as written.",
    "For each: name; pass is true only when all six criteria are met; failed_criteria lists the lower-case names of the criteria it fails (empty when pass is true); objection is one line, under 200 characters, saying what is wrong and what would fix it (empty when pass is true); rename_to is a better name for a capability that passes but whose name could be clearer or shorter (empty when its name is right). A better name follows the same rules: dotted lower-case snake_case, at most 4 parts and 48 characters, never saying how, and ending in the noun it yields or a specific verb, never run, check, handle, process, do, manage, execute, perform, fetch or get. A capability that is useful and distinct but fails only on its name (irreducible, complete, clear or concise) is still a failure: give rename_to the name that fixes it, and it is kept under that name. Give no rename_to for a capability that fails on distinct or useful.",
  ].join("\n"),
  schema: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        pass: { type: "boolean" },
        failed_criteria: {
          type: "array",
          items: { type: "string", enum: ["distinct", "useful", "irreducible", "complete", "clear", "concise"] },
        },
        objection: { type: "string", maxLength: 200 },
        rename_to: { type: "string", maxLength: 48 },
      },
      required: ["name", "pass", "failed_criteria", "objection"],
      additionalProperties: false,
    },
  },
  examples: [{
    prompt: [
      "Source: ~/Developer/photos (folder)",
      "Proposed capabilities:",
      "Capability: photo.duplicate.find",
      "Purpose: Lists groups of photos that are the same picture.",
      "Reason: Someone cleaning an archive runs it before deleting anything.",
      "Input: a folder of photos",
      "Output: groups of duplicate photos",
      "",
      "Capability: photo.run",
      "Purpose: Runs the photo tools in order.",
      "Reason: One command for the whole import.",
      "Input: a folder of photos",
      "Output: a finished album",
      "",
      "Capability: photo.date.fix",
      "Purpose: Rewrites wrong taken-at dates from file names and neighbours.",
      "Reason: Albums sort wrongly until dates are right.",
      "Input: photos with missing or wrong dates",
      "Output: the corrected date for each photo",
    ].join("\n"),
    answer: {
      Verdicts: [
        { name: "photo.duplicate.find", pass: true, failed_criteria: [], objection: "", rename_to: "" },
        {
          name: "photo.run",
          pass: false,
          failed_criteria: ["clear", "concise", "useful"],
          objection: "Ends in the filler verb run and sequences other capabilities; drop it and keep the capabilities it runs.",
          rename_to: "",
        },
        { name: "photo.date.fix", pass: true, failed_criteria: [], objection: "", rename_to: "photo.taken_date.fix" },
      ],
    },
  }],
};

/** The yes/no a model states about a leaf against the registered capabilities (Mastra: a decision question, P(yes)). */
export const REGISTERED: Question = {
  field: "Distinct",
  instructions: [
    "A capability someone may want to run was proposed. The registered capabilities that already exist are listed as context. Does the proposed one do something none of the registered ones does?",
    "true: Its input and output differ from every registered capability's, and it is not one of them under another name.",
    "false: A registered capability already gives the same output from the same input, or this is that capability under another name.",
    "Answer with the JSON boolean, true or false: you state it; no probability is asked for.",
  ].join("\n"),
  schema: { type: "boolean" },
  examples: [],
};

export const PSEUDOCODE: Question = {
  field: "Pseudocode",
  instructions: [
    "A capability was proposed from a source and listed with its input and output fields. Write what it does as pseudocode, in the idiom of a capability runtime: a pure function of its validated input, whose model calls and side effects go through named, separate steps.",
    "input: the input schema in one line, naming every input field with its type.",
    "steps: in order, from 1 to 14 short steps. Each step has a kind and a line. kind \"det\" is code only (parse, filter, compare, validate, merge, count). kind \"model\" is a call to a model: say whether it is a decision question (a list of yes/no or choice questions answered with probabilities) or a generated reply, and name the question. kind \"host\" reads or changes the machine or a service (a file, a process, a request): a gatherer that reads inputs before the run, or an effect. Start with how the input is gathered, put the deterministic checks of any model reply after the call that made it, and mark every step.",
    "output: the output schema in one line, naming every output field with its type.",
    "apply: what running it for real changes outside the program, or \"nothing\" when it only returns its output.",
    "Use the exact field names given; name every input field in input and every output field in output. Do not describe more than the capability's purpose.",
  ].join("\n"),
  schema: {
    type: "object",
    properties: {
      input: { type: "string", minLength: 1 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 14,
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: ["det", "model", "host"] }, line: { type: "string", minLength: 1 } },
          required: ["kind", "line"],
          additionalProperties: false,
        },
      },
      output: { type: "string", minLength: 1 },
      apply: { type: "string", minLength: 1 },
    },
    required: ["input", "steps", "output", "apply"],
    additionalProperties: false,
  },
  examples: [{
    prompt: [
      "Source: ~/Developer/photos (folder)",
      "Capability: photo.duplicate.find",
      "Kind: deterministic",
      "Purpose: Lists groups of photos that are the same picture.",
      "Input fields: folder",
      "Output fields: groups",
    ].join("\n"),
    answer: {
      Pseudocode: {
        input: "{ folder: string }",
        steps: [
          { kind: "host", line: "gather the files under folder with their sizes and content hashes" },
          { kind: "det", line: "group files by content hash, keep groups of two or more" },
          { kind: "det", line: "order each group by modified time, oldest first" },
        ],
        output: "{ groups: [{ hash: string, files: string[] }] }",
        apply: "nothing",
      },
    },
  }],
};

/**
 * What a model reads for one question: its instructions, the examples, the input, then the reply schema (an object
 * whose one required key is the question's field). The text asks for JSON only: the step is a bare completion.
 */
export function modelPrompt(question: Question, input: string): string {
  const reply = {
    type: "object",
    properties: { [question.field]: question.schema },
    required: [question.field],
    additionalProperties: false,
  };
  const examples = question.examples.map((example) =>
    `Example:\nPrompt:\n${example.prompt}\nAnswer:\n${JSON.stringify(example.answer, null, 2)}\n`
  ).join("\n");
  return [
    `## ${question.field}`,
    question.instructions,
    ...(examples === "" ? [] : ["", examples]),
    "Prompt:",
    input,
    "",
    "Respond with only one JSON object matching this schema, no other text:",
    JSON.stringify(reply),
    "",
  ].join("\n");
}
