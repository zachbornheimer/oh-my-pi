import { describe, expect, it } from "bun:test";
import type { Candidate } from "./candidates.ts";
import { type Decision, draftSteps, uniqueKey } from "./draft_steps.ts";

const candidate = (id: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  title: `Title ${id}`,
  commandOnly: false,
  text: `text ${id}`,
  context: "",
  evidence: [{ line: 1 }],
  retried: false,
  ...overrides,
});
const decide = (overrides: Partial<Decision> = {}): Decision => ({
  kind: "command",
  keep: true,
  approval: false,
  ...overrides,
});

describe("draftSteps", () => {
  it("chains the kept steps and counts the incidental ones", () => {
    const drafts = draftSteps(
      [
        candidate("c1", { title: "Build", command: "make", commandOnly: true }),
        candidate("c2"),
        candidate("c3", { title: "Ship", command: "make ship", commandOnly: true }),
      ],
      [decide(), decide({ keep: false }), decide()],
    );
    expect(drafts.incidental).toBe(1);
    expect(drafts.steps.map((step) => [step.key, step.kind, step.run, step.requires])).toEqual([
      ["build", "command", "make", []],
      ["ship", "command", "make ship", ["build"]],
    ]);
  });

  it("splits a line that carries a command into the judgment and the command", () => {
    const drafts = draftSteps(
      [candidate("c1", { title: "Tickets", command: "webmaster plan {site}" })],
      [decide({ kind: "judgment" })],
    );
    expect(drafts.steps.map((step) => [step.key, step.kind, step.run, step.requires, step.on_failure])).toEqual([
      ["tickets", "judgment", undefined, [], "ask"],
      ["run_webmaster_plan", "command", "webmaster plan {site}", ["tickets"], "stop"],
    ]);
  });

  it("puts an approval before a command a person should authorize", () => {
    const drafts = draftSteps(
      [candidate("c1", { title: "Publish", command: "deploy --prod", commandOnly: true })],
      [decide({ approval: true })],
    );
    expect(drafts.steps.map((step) => [step.key, step.kind, step.requires])).toEqual([
      ["approve_publish", "approval", []],
      ["publish", "command", ["approve_publish"]],
    ]);
  });

  it("adds no second approval to a step that is already one", () => {
    const drafts = draftSteps([candidate("c1", { title: "Confirm" })], [decide({ kind: "approval", approval: true })]);
    expect(drafts.steps.map((step) => step.kind)).toEqual(["approval"]);
  });

  it("settles an edit and a command-only candidate whatever the model said", () => {
    const drafts = draftSteps(
      [
        candidate("c1", { title: "Edit a.ts", edit: "a.ts" }),
        candidate("c2", { title: "Run", command: "make", commandOnly: true }),
      ],
      [decide({ kind: "judgment" }), decide({ kind: "approval" })],
    );
    expect(drafts.steps.map((step) => step.kind)).toEqual(["edit", "command"]);
  });

  it("makes a command with no run a judgment, and a retried command retry once", () => {
    const drafts = draftSteps(
      [
        candidate("c1", { title: "Think" }),
        candidate("c2", { title: "Build", command: "make", commandOnly: true, retried: true }),
      ],
      [decide(), decide()],
    );
    expect(drafts.steps.map((step) => [step.kind, step.on_failure])).toEqual([["judgment", "ask"], [
      "command",
      "retry_once",
    ]]);
  });
});

describe("uniqueKey", () => {
  it("slugs the title and numbers repeats", () => {
    expect(uniqueKey("Deploy to production!", new Set())).toBe("deploy_to_production");
    expect(uniqueKey("Build", new Set(["build", "build_2"]))).toBe("build_3");
    expect(uniqueKey("42 things", new Set())).toBe("step_42_things");
    expect(uniqueKey("***", new Set())).toBe("step");
    expect(uniqueKey("webmaster version must print at least the version in policies tiers md", new Set())).toBe(
      "webmaster_version_must_print_at_least",
    );
  });
});
