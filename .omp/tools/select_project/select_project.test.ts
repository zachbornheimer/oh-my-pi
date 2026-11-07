import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import factory from "./index.js";
import { DEFAULT_SUBJECT_BUDGET, selectProjectInput } from "./input.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep } from "./omp_model.js";
import { chosenFrom, menuNames, PROJECT_INSTRUCTIONS, refuseReservedName, selected } from "./selection.js";
import { projectPrompt, runSelectProject } from "./select.js";
import { describe as describeProject, subjectText } from "./thread.js";

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

interface Machine {
  input: Record<string, unknown>;
  menu: string[];
  rules: string[];
  state_fragments: string[];
}
interface TextCase {
  name: string;
  input: Record<string, unknown>;
  fragments: string[];
  absent: string[];
}

const pick = (Project: string, confidence: number | string = 0.9): string => JSON.stringify({ Project, confidence });

function fakeModel(...replies: (string | Error)[]) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const next = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { step, prompts };
}

describe("TestSelectProject_AsksOneQuestionWithTheLiveProjectsAsTheMenu", () => {
  it("asks one model run over the live projects and new, with the rules and the thread", async () => {
    const machine = await fixture<Machine>("machine_with_thread.json");
    const model = fakeModel(pick("Homelab", 0.8));
    const result = await runSelectProject(machine.input, { step: model.step });
    expect(result).toEqual({ ProjectName: "Homelab", ProjectID: "", NeedsNewProject: false, Confidence: 0.8 });
    expect(model.prompts).toHaveLength(1);
    const prompt = model.prompts[0]!;
    for (const name of machine.menu) expect(prompt).toContain(`- ${JSON.stringify(name)}`);
    for (const rule of machine.rules) expect(PROJECT_INSTRUCTIONS.replaceAll("\n", " "), rule).toContain(rule.replaceAll("\n", " "));
    expect(prompt).toContain(PROJECT_INSTRUCTIONS);
    for (const fragment of machine.state_fragments) expect(prompt).toContain(fragment);
    expect(prompt).toContain('"Project": "AgentMux" | "Homelab" | "new"');
  });

  it("returns the chosen record's id", async () => {
    const result = await runSelectProject(
      { Turns: [{ Role: "user", Text: "x" }], Projects: [{ ID: "p-1", Name: " Homelab " }, { ID: "p-2", Name: "AgentMux" }] },
      { step: fakeModel(pick("Homelab")).step },
    );
    expect(result).toEqual({ ProjectName: "Homelab", ProjectID: "p-1", NeedsNewProject: false, Confidence: 0.9 });
  });
});

describe("TestSelectProject_NewCallsForANewProject", () => {
  it("returns NeedsNewProject with no name", async () => {
    const machine = await fixture<Machine>("machine_with_thread.json");
    expect(await runSelectProject(machine.input, { step: fakeModel(pick("new", 0.6)).step })).toEqual({
      ProjectName: "",
      ProjectID: "",
      NeedsNewProject: true,
      Confidence: 0.6,
    });
  });

  it("answers new with no model run when there are no live projects", async () => {
    const model = fakeModel(pick("x"));
    expect(await runSelectProject({ Turns: [{ Role: "user", Text: "x" }] }, { step: model.step })).toEqual({
      ProjectName: "",
      ProjectID: "",
      NeedsNewProject: true,
      Confidence: null,
    });
    expect(model.prompts).toHaveLength(0);
  });

  it("ignores blank project names, so a thread whose projects are all blank is new with no model run", async () => {
    const model = fakeModel(pick("x"));
    const result = await runSelectProject({ Turns: [{ Role: "user", Text: "x" }], Projects: [{ Name: "  " }] }, { step: model.step });
    expect(result.NeedsNewProject).toBe(true);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("TestSelect_AsksAgainWhenTheChoiceIsNotOnTheMenu", () => {
  it("asks again with the reason and returns the second answer", async () => {
    const machine = await fixture<Machine>("machine_with_thread.json");
    const model = fakeModel(pick("Nonexistent"), pick("AgentMux"));
    const result = await runSelectProject(machine.input, { step: model.step });
    expect(result).toEqual({ ProjectName: "AgentMux", ProjectID: "", NeedsNewProject: false, Confidence: 0.9 });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain('project "Nonexistent" is not on the menu: choose one of ["AgentMux" "Homelab"] or "new"');
  });

  it("asks again on a missing or out-of-range confidence and on prose, then fails `ask which project:` after three", async () => {
    const machine = await fixture<Machine>("machine_with_thread.json");
    const model = fakeModel(pick("Homelab", "high"), "I think Homelab", pick("Homelab", 2));
    await expect(runSelectProject(machine.input, { step: model.step })).rejects.toThrow(/^ask which project: no valid reply after 3 attempts: confidence must be a number from 0 to 1, got 2/);
    expect(model.prompts[1]).toContain("confidence must be a number from 0 to 1");
    expect(model.prompts[2]).toContain("the reply is not JSON");
  });
});

describe("TestSelectProject_NamesTheFailedStep", () => {
  it("names the ask and wraps the model failure", async () => {
    const machine = await fixture<Machine>("machine_with_thread.json");
    await expect(runSelectProject(machine.input, { step: fakeModel(new Error("model down")).step })).rejects.toThrow(/ask which project: model down/);
  });

  it("refuses a thread with no conversation, naming the field", () => {
    expect(() => selectProjectInput({ Turns: [], Projects: [] })).toThrow(/Turns must have at least one turn/);
    expect(() => selectProjectInput({ Projects: [] })).toThrow(/Turns must have at least one turn/);
    expect(() => selectProjectInput(null)).toThrow(/the input must be an object/);
  });

  it("refuses wrong types, naming the field", () => {
    const turns = [{ Role: "user", Text: "x" }];
    expect(() => selectProjectInput({ Turns: [{ Role: "user" }] })).toThrow("Turns[0].Text must be a string");
    expect(() => selectProjectInput({ Turns: turns, Projects: [{ Goal: "g" }] })).toThrow("Projects[0].Name must be a string");
    expect(() => selectProjectInput({ Turns: turns, Projects: "x" })).toThrow("Projects must be an array");
    expect(() => selectProjectInput({ Turns: turns, ProjectBudget: 0 })).toThrow("ProjectBudget must be a positive integer");
    expect(() => selectProjectInput({ Turns: turns, Branch: 3 })).toThrow("Branch must be a string");
    expect(() => selectProjectInput({ Turns: turns, Projects: [{ Name: "A", Contents: { Entries: [1] } }] })).toThrow("Projects[0].Contents.Entries must be an array of strings");
  });

  it("treats null optionals as absent", () => {
    const input = selectProjectInput({ Turns: [{ Role: "user", Text: "x" }], Current: null, Projects: null, Branch: null, ProjectBudget: null });
    expect(input).toMatchObject({ Branch: "", Projects: [], WorkDir: "" });
    expect(input.Current).toBeUndefined();
    expect(input.ProjectBudget).toBeUndefined();
  });

  it("FIXED: refuses a live project named new, which could not be told from the menu's own new entry", async () => {
    expect(() => refuseReservedName(["A", "new"])).toThrow(/is named "new"/);
    const model = fakeModel(pick("new"));
    await expect(runSelectProject({ Turns: [{ Role: "user", Text: "x" }], Projects: [{ Name: "new" }] }, { step: model.step })).rejects.toThrow(/is named "new"/);
    expect(model.prompts).toHaveLength(0);
  });

  it("propagates cancellation without wrapping it", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort();
      throw new Error("cancelled");
    };
    await expect(runSelectProject({ Turns: [{ Role: "user", Text: "x" }], Projects: [{ Name: "A" }] }, { step, signal: controller.signal })).rejects.not.toThrow(/ask which project/);
  });
});

describe("Selection", () => {
  it("TestSelection_NamesTheLiveProject / NewCallsForANewProject", () => {
    expect(selected("Homelab")).toEqual({ ProjectName: "Homelab", ProjectID: "", NeedsNewProject: false, Confidence: null });
    expect(selected("new")).toEqual({ ProjectName: "", ProjectID: "", NeedsNewProject: true, Confidence: null });
  });

  it("TestSelection_ChosenFromTakesMenuEntries", () => {
    for (const value of ["AgentMux", "Homelab", "new"]) expect(() => chosenFrom(value, ["AgentMux", "Homelab"])).not.toThrow();
  });

  it("TestSelection_ChosenFromRefusesAnUnknownProject", () => {
    for (const value of ["Nonexistent", ""]) expect(() => chosenFrom(value, ["AgentMux"])).toThrow(/is not on the menu/);
  });

  it("lists the live names once each, trimmed, without blanks, then the prompt adds new", () => {
    const projects = selectProjectInput({ Turns: [{ Role: "user", Text: "x" }], Projects: [{ Name: "alpha" }, { Name: "" }, { Name: " alpha " }, { Name: "beta" }] }).Projects;
    expect(menuNames(projects)).toEqual(["alpha", "beta"]);
    expect(projectPrompt("<thread>t</thread>", ["alpha", "beta"])).toContain('- "alpha"\n- "beta"\n- "new": ');
  });

  it("TestRecordDescription_PrefersTheSummaryOverTheGoal", () => {
    const record = (Goal: string, Summary: string) =>
      selectProjectInput({ Turns: [{ Role: "user", Text: "x" }], Projects: [{ Name: "A", Goal, Summary }] }).Projects[0]!;
    expect(describeProject(record(" goal ", " summary "))).toBe("summary");
    expect(describeProject(record(" goal ", ""))).toBe("goal");
  });
});

describe("Conversation.SubjectText (agentmux thread_test.go cases)", () => {
  it("shows every part, fragment by fragment", async () => {
    const { cases } = await fixture<{ cases: TextCase[] }>("subject_text.json");
    expect(cases.length).toBeGreaterThan(3);
    for (const testCase of cases) {
      const text = subjectText(selectProjectInput(testCase.input));
      for (const fragment of testCase.fragments) expect(text, `${testCase.name}: ${fragment}`).toContain(fragment);
      for (const fragment of testCase.absent) expect(text, `${testCase.name}: not ${fragment}`).not.toContain(fragment);
    }
  });

  it("shows less of each project when the list is over its budget", () => {
    const parsed = selectProjectInput({
      Turns: [{ Role: "user", Text: "x" }],
      ProjectBudget: 40,
      Projects: [{ Name: "A", Goal: "g", Home: "/a", Contents: { Entries: ["x/"], Readme: "r" } }],
    });
    const text = subjectText(parsed);
    expect(text).toContain("- A\n  home: /a\n");
    expect(text).not.toContain("contains:");
    expect(text).not.toContain("readme:");
    expect(text).toContain("stored note: g");
    expect(DEFAULT_SUBJECT_BUDGET).toBe(16384);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }
  const noExec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

  it("describes itself in 80 to 250 words, naming its sibling", () => {
    const tool = factory(pi(noExec)) as { name: string; description: string };
    expect(tool.name).toBe("select_project");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(tool.description).toContain("describe_project");
  });

  it("runs through execute with a fake omp, a private prompt file removed afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], text: await readFile(args[1]!.slice(1), "utf8"), cwd: options?.cwd };
      return { stdout: pick("Homelab", 0.95), stderr: "", code: 0, killed: false };
    };
    const machine = await fixture<Machine>("machine_with_thread.json");
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
    };
    const result = await tool.execute("id", machine.input, undefined, undefined, undefined);
    expect(result.details).toEqual({ ProjectName: "Homelab", ProjectID: "", NeedsNewProject: false, Confidence: 0.95 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details as object);
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toContain("Currently filed under: AgentMux");
    expect(existsSync(seen!.cwd!)).toBe(false);
  });

  it("fails the call, not a success, when omp exits non-zero", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "no key", code: 1, killed: false });
    const machine = await fixture<Machine>("machine_with_thread.json");
    const tool = factory(pi(exec)) as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    await expect(tool.execute("id", machine.input, undefined, undefined, undefined)).rejects.toThrow(/ask which project: no valid reply|ask which project: model step exited 1: no key/);
  });
});
