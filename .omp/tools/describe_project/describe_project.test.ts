import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  BLANK_DESCRIPTION_MESSAGE,
  DESCRIPTION_REPLY_JSON_SCHEMA,
  describedMaterial,
  descriptionPrompt,
  knownProjects,
  liveNamed,
  NO_WORDS_MESSAGE,
  parseDescription,
  runDescribeProject,
} from "./describe.js";
import factory from "./index.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep } from "./omp_model.js";

const reply = (description: string): string => JSON.stringify({ Description: description });

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

describe("describe_project parity with agentmux (describe_project_test.go)", () => {
  it("fails blank words before asking a model", async () => {
    const model = fakeModel(reply("unused"));
    for (const text of ["  ", "", "\n\t", undefined, 4]) {
      await expect(runDescribeProject(text, undefined, { step: model.step })).rejects.toThrow(NO_WORDS_MESSAGE);
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("describes the named project from its name and goal, in one model run", async () => {
    const model = fakeModel(reply("Delegates work across agents."));
    const projects = [{ id: "p-mux", name: "AgentMux", goal: "delegate work" }];
    expect(await runDescribeProject("agentmux", projects, { step: model.step })).toBe("Delegates work across agents.");
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("Project AgentMux. delegate work");
  });

  it("asks the model for the trimmed material and returns the reply unchanged", async () => {
    const model = fakeModel(reply("A cache service."));
    expect(await runDescribeProject("  the cache service\n", undefined, { step: model.step })).toBe("A cache service.");
    expect(model.prompts[0]).toContain("<<<\nthe cache service\n>>>");
  });

  it("sends the lead, the material fenced as data, then the reply schema", () => {
    const prompt = descriptionPrompt("the cache service");
    expect(prompt.startsWith("Write a project description for the following material.")).toBe(true);
    expect(prompt).toContain("<<<\nthe cache service\n>>>");
    expect(prompt.endsWith(`Respond as JSON matching this schema: ${JSON.stringify(DESCRIPTION_REPLY_JSON_SCHEMA)}`)).toBe(true);
  });

  it("FIXED: does not promise the model can explore files, which a bare completion cannot", () => {
    expect(descriptionPrompt("x")).not.toContain("explore");
    expect(descriptionPrompt("x")).toContain("You have no tools");
  });

  it("asks again when the reply is blank or not the reply object", async () => {
    const model = fakeModel("not json", reply("   "), reply("A cache service."));
    expect(await runDescribeProject("cache", undefined, { step: model.step })).toBe("A cache service.");
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[1]).toContain("the reply is not JSON");
    expect(model.prompts[2]).toContain(BLANK_DESCRIPTION_MESSAGE);
  });

  it("fails `write the description: <cause>` after three bad replies", async () => {
    const model = fakeModel(reply(""));
    await expect(runDescribeProject("cache", undefined, { step: model.step })).rejects.toThrow(
      `write the description: no valid reply after 3 attempts: ${BLANK_DESCRIPTION_MESSAGE}`,
    );
  });

  it("fails `write the description: <cause>` when the model run fails", async () => {
    await expect(runDescribeProject("cache", undefined, { step: fakeModel(new Error("down")).step })).rejects.toThrow("write the description: down");
  });

  it("propagates cancellation without wrapping it", async () => {
    const controller = new AbortController();
    const step: ModelStep = async () => {
      controller.abort();
      throw new Error("cancelled");
    };
    await expect(runDescribeProject("x", undefined, { step, signal: controller.signal })).rejects.not.toThrow(/write the description/);
  });
});

describe("parseDescription", () => {
  it("trims a description and refuses anything else", () => {
    expect(parseDescription({ Description: "  hi \n" })).toBe("hi");
    expect(() => parseDescription({ Description: 3 })).toThrow(/must be \{"Description": string\}/);
    expect(() => parseDescription(null)).toThrow(/must be \{"Description": string\}/);
    expect(() => parseDescription({ Description: " " })).toThrow(BLANK_DESCRIPTION_MESSAGE);
  });
});

describe("the caller-supplied project list", () => {
  const projects = [
    { id: "p-old", name: "Cache", goal: "old", merged_into: "p-new" },
    { id: "p-new", name: " Cache ", goal: "keep it fast" },
  ];

  it("matches by id first, then by trimmed case-insensitive name", () => {
    expect(liveNamed(projects, "p-new")?.id).toBe("p-new");
    expect(liveNamed(projects, "CACHE")?.id).toBe("p-new");
  });

  it("never names a project that was merged into another", () => {
    expect(liveNamed(projects, "p-old")).toBeUndefined();
  });

  it("falls back to the input and trims a project with no goal", () => {
    expect(describedMaterial("the cache service", projects)).toBe("the cache service");
    expect(describedMaterial("lone", [{ id: "x", name: "Lone" }])).toBe("Project Lone.");
  });

  it("reads a project's fields, treating null as absent, and refuses malformed records naming the field", () => {
    expect(knownProjects(undefined)).toEqual([]);
    expect(knownProjects(null)).toEqual([]);
    expect(knownProjects([{ id: "a", name: "A", goal: null, merged_into: "" }])).toEqual([{ id: "a", name: "A", merged_into: "" }]);
    expect(() => knownProjects("x")).toThrow("projects must be an array");
    expect(() => knownProjects([3])).toThrow("projects[0] must be an object");
    expect(() => knownProjects([{ id: "a" }])).toThrow("projects[0].name must be a string");
    expect(() => knownProjects([{ id: "a", name: "A", goal: 1 }])).toThrow("projects[0].goal must be a string");
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as { name: string; description: string };
    expect(tool.name).toBe("describe_project");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["select_project", "rewrite_dictated_text"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp, a private prompt file removed afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], text: await readFile(args[1]!.slice(1), "utf8"), cwd: options?.cwd };
      return { stdout: `\`\`\`json\n${reply("Delegates work.")}\n\`\`\``, stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }>;
    };
    const result = await tool.execute("id", { text: "agentmux", projects: [{ id: "p", name: "AgentMux", goal: "delegate work", merged_into: null }] }, undefined, undefined, undefined);
    expect(result.content[0]!.text).toBe("Delegates work.");
    expect(result.details).toEqual({ Description: "Delegates work." });
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toContain("Project AgentMux. delegate work");
    expect(existsSync(seen!.cwd!)).toBe(false);
  });

  it("fails the call, not a success, when omp exits non-zero", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "no key", code: 1, killed: false });
    const tool = factory(pi(exec)) as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    await expect(tool.execute("id", { text: "x" }, undefined, undefined, undefined)).rejects.toThrow("write the description: model step exited 1: no key");
  });
});
