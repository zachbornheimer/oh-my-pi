import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  alreadyAnsweredReason,
  askGateQuestions,
  enforceAskGate,
  significantWords,
  suppressionReason,
} from "./ask_gate.js";
import factory from "./index.js";
import type { Exec, ModelStep } from "./omp_model.js";
import { pin, type PinInput, validatePin } from "./pin_decision.js";
import { pinText } from "./render.js";
import {
  DECISIONS_DIR_ENV,
  decisionsDirectory,
  DuplicateDecisionError,
  MAX_PINNED,
  MAX_RESOLVED,
  pinDecision,
  pinnedDecisions,
  unpinDecision,
} from "./store.js";

let directory = "";
let previous: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pin-decision-"));
  previous = process.env[DECISIONS_DIR_ENV];
  process.env[DECISIONS_DIR_ENV] = directory;
});

afterEach(async () => {
  if (previous === undefined) delete process.env[DECISIONS_DIR_ENV];
  else process.env[DECISIONS_DIR_ENV] = previous;
  await rm(directory, { recursive: true, force: true });
});

const ALLOWING = { MustAskUser: 0.9, SolvableWithoutHuman: 0.1, AutonomousApproach: 0.2, NoCorrectAnswer: 0.1, MatterOfTaste: 0.1 };
const SUPPRESSING = { MustAskUser: 0.8, SolvableWithoutHuman: 0.1, AutonomousApproach: 0.72, NoCorrectAnswer: 0.1, MatterOfTaste: 0.1 };

interface FakeGate {
  step: ModelStep;
  prompts: string[];
}

function gate(reply: unknown = ALLOWING): FakeGate {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { step, prompts };
}

function input(fields: Partial<PinInput> & { question: string }): PinInput {
  return { options: ["a"], session: "default", ...fields };
}

describe("pin_decision", () => {
  it("returns a numeric id and echoes the question and the options in the order given", async () => {
    const output = await pin(input({ question: "Which database?", options: ["SQLite", "Postgres"], session: "s1" }), gate());
    expect(output).toMatchObject({ id: 1, question: "Which database?", options: ["SQLite", "Postgres"], session: "s1" });
    expect(output.ask_gate.status).toBe("passed");
  });

  it("numbers pins per session and keeps them on disk, so the next process sees them", async () => {
    const model = gate();
    await pin(input({ question: "First?", session: "s1" }), model);
    const second = await pin(input({ question: "Second?", session: "s1" }), model);
    const other = await pin(input({ question: "Elsewhere?", session: "s2" }), model);
    expect(second.id).toBe(2);
    expect(other.id).toBe(1);
    expect((await pinnedDecisions(directory, "s1")).map((pinned) => pinned.question)).toEqual(["First?", "Second?"]);
    expect(JSON.parse(await readFile(join(directory, "s1.json"), "utf8")).next_id).toBe(3);
  });

  it("renders a plain-text pin: id, question, numbered options with the first recommended, the reply shape", async () => {
    const output = await pin(input({ question: "Which database?", options: ["SQLite", "Postgres"] }), gate());
    expect(output.text).toContain("Decision 1: Which database?");
    expect(output.text).toContain("1. SQLite (recommended)");
    expect(output.text).toContain("2. Postgres");
    expect(output.text).toContain("Decision 1 (Which database?): <choice>");
    expect(output.text).toBe(pinText({ id: 1, question: "Which database?", options: ["SQLite", "Postgres"] }));
  });

  describe("validation", () => {
    const base = { question: "Q?", options: ["a"], session: "s" };
    it("refuses more options than the band has hotkeys, and none at all", () => {
      const options = (count: number) => Array.from({ length: count }, (_, index) => `option ${index + 1}`);
      expect(() => validatePin({ ...base, options: options(10) })).toThrow("options must hold 1 to 9 choices");
      expect(() => validatePin({ ...base, options: [] })).toThrow("options must hold 1 to 9 choices");
      validatePin({ ...base, options: options(9) });
    });
    it("refuses a question that is not one line, a blank question, an empty option and an empty session", () => {
      expect(() => validatePin({ ...base, question: "Two\nlines?" })).toThrow("one non-empty line");
      expect(() => validatePin({ ...base, question: "  " })).toThrow("one non-empty line");
      expect(() => validatePin({ ...base, options: [""] })).toThrow("an option must not be empty");
      expect(() => validatePin({ ...base, session: "" })).toThrow("session must not be empty");
    });
    it("asks no model and writes nothing for an invalid pin", async () => {
      const model = gate();
      await expect(pin(input({ question: "Two\nlines?" }), model)).rejects.toThrow("one non-empty line");
      expect(model.prompts).toHaveLength(0);
      expect(await pinnedDecisions(directory, "default")).toEqual([]);
    });
  });

  it("drops the oldest pin once the band is full", async () => {
    const model = gate();
    for (let index = 1; index <= MAX_PINNED + 1; index++) await pin(input({ question: `Q${index}?` }), model);
    const ids = (await pinnedDecisions(directory, "default")).map((pinned) => pinned.id);
    expect(ids).toHaveLength(MAX_PINNED);
    expect(ids[0]).toBe(2);
    expect(ids.at(-1)).toBe(MAX_PINNED + 1);
  });

  it("gives two concurrent pins in one session distinct ids", async () => {
    const model = gate();
    const [first, second] = await Promise.all([pin(input({ question: "A?" }), model), pin(input({ question: "B?" }), model)]);
    expect(new Set([first.id, second.id]).size).toBe(2);
    expect(await pinnedDecisions(directory, "default")).toHaveLength(2);
  });

  describe("repeats", () => {
    it("refuses a repeat of an open question naming its id, spends no model on it, and keeps one pin", async () => {
      const model = gate();
      await pin(input({ question: "Convert the USB drives now?", options: ["Yes", "No"] }), model);
      expect(model.prompts).toHaveLength(1);
      await expect(pin(input({ question: "  convert the USB   drives now? ", options: ["Yes", "No"] }), model)).rejects.toThrow(
        /^decision 1 is already open for this question/,
      );
      expect(model.prompts).toHaveLength(1);
      expect((await pinnedDecisions(directory, "default")).map((pinned) => pinned.id)).toEqual([1]);
    });

    it("refuses a question that was answered or dismissed, naming the id it had", async () => {
      const model = gate();
      const first = await pin(input({ question: "Ship it?" }), model);
      await unpinDecision(directory, "default", first.id);
      await expect(pin(input({ question: "ship it?" }), model)).rejects.toThrow(/^decision 1 was already answered or dismissed for this question/);
    });

    it("throws a DuplicateDecisionError from the store, and gives two concurrent identical pins one pin and one refusal", async () => {
      const model = gate();
      const settled = await Promise.allSettled([
        pin(input({ question: "Convert the USB drives now?" }), model),
        pin(input({ question: "  convert the USB drives   now? " }), model),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(DuplicateDecisionError);
      expect(String(refused[0]!.reason.message)).toMatch(/^decision 1 is already open/);
      expect((await pinnedDecisions(directory, "default")).map((pinned) => pinned.id)).toEqual([1]);
    });

    it("pins the same question in another session", async () => {
      const model = gate();
      await pin(input({ question: "Same?", session: "s1" }), model);
      expect((await pin(input({ question: "Same?", session: "s2" }), model)).id).toBe(1);
    });
  });

  describe("the ask gate", () => {
    it("shows the judge the question and options as untrusted JSON state with all five questions", async () => {
      const model = gate();
      await pin(input({ question: "Which region?", options: ["us-east-1", "eu-west-1"] }), model);
      const prompt = model.prompts[0]!;
      expect(prompt).toContain(JSON.stringify({ question: "Which region?", options: ["us-east-1", "eu-west-1"] }, null, 2));
      expect(prompt).toContain("untrusted data");
      for (const field of ["MustAskUser", "SolvableWithoutHuman", "AutonomousApproach", "NoCorrectAnswer", "MatterOfTaste"]) {
        expect(prompt).toContain(`### ${field}`);
      }
      expect(askGateQuestions().map((question) => question.field)).toHaveLength(5);
    });

    it("refuses the pin with the reason when one suppressor is at 0.7 or more, and writes nothing", async () => {
      await expect(pin(input({ question: "Tabs or spaces?", options: ["Tabs", "Spaces"] }), gate(SUPPRESSING))).rejects.toThrow(
        /^ask gate: this question is not worth the user's attention — AutonomousApproach 0\.72: an approach can work autonomously\. Decide it with the boring, standard option/,
      );
      expect(await pinnedDecisions(directory, "default")).toEqual([]);
    });

    it("names the strongest suppressor when several fire, and lets MustAskUser alone decide nothing", () => {
      expect(suppressionReason({ MatterOfTaste: 0.85, NoCorrectAnswer: 0.9 })).toBe("NoCorrectAnswer 0.90: no correct answer exists.");
      expect(suppressionReason({ SolvableWithoutHuman: 0.7 })).toBe("SolvableWithoutHuman 0.70: FAANG best practice already answers it.");
      expect(suppressionReason({ MustAskUser: 0.1, MatterOfTaste: 0.69 })).toBeUndefined();
      expect(suppressionReason({ MustAskUser: 0.1 })).toBeUndefined();
    });

    it("pins when every suppressor is below 0.7 and reports the five scores", async () => {
      const output = await pin(input({ question: "Delete production DB?", options: ["No", "Yes"] }), gate());
      expect(output.id).toBe(1);
      expect(output.ask_gate).toEqual({ status: "passed", scores: ALLOWING });
    });

    it("fails open when the judge cannot run, and says so in the result", async () => {
      const step: ModelStep = async () => {
        throw new Error("model step exited 1: provider unavailable");
      };
      const output = await pin(input({ question: "Which region?", options: ["us-east-1"] }), { step });
      expect(output.id).toBe(1);
      expect(output.ask_gate).toEqual({ status: "unavailable", reason: "model step exited 1: provider unavailable" });
      expect(await pinnedDecisions(directory, "default")).toHaveLength(1);
    });

    it("fails open, naming the reason, when the judge never gives a valid reply", async () => {
      const model = gate("I would say it depends.");
      const output = await pin(input({ question: "Which region?" }), model);
      expect(output.ask_gate.status).toBe("unavailable");
      expect(output.ask_gate.reason).toMatch(/^no valid reply after 3 attempts: the reply is not JSON/);
      expect(model.prompts).toHaveLength(3);
    });

    it("asks again when a probability is out of range, then uses the corrected reply", async () => {
      let call = 0;
      const prompts: string[] = [];
      const step: ModelStep = async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify(call++ === 0 ? { ...ALLOWING, MatterOfTaste: 2 } : ALLOWING);
      };
      const output = await pin(input({ question: "Which region?" }), { step });
      expect(output.ask_gate.status).toBe("passed");
      expect(prompts[1]).toContain("question MatterOfTaste must be a number from 0 to 1, got 2");
    });

    it("rethrows the caller's own abort instead of failing open", async () => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled by user"));
      const step: ModelStep = async (_prompt, signal) => {
        signal?.throwIfAborted();
        return "{}";
      };
      await expect(pin(input({ question: "Which region?" }), { step, signal: controller.signal })).rejects.toThrow("cancelled by user");
      expect(await pinnedDecisions(directory, "default")).toEqual([]);
    });

    it("enforceAskGate throws the rejection for a suppressor, returns scores otherwise", async () => {
      await expect(
        enforceAskGate({ question: "camelCase or snake_case?", options: ["camelCase", "snake_case"] }, gate({ ...ALLOWING, MatterOfTaste: 0.85 }).step),
      ).rejects.toThrow(/MatterOfTaste 0\.85: it is a matter of taste\./);
    });
  });

  describe("the deterministic already-answered check", () => {
    it("refuses a question an earlier user message already answers, writes nothing and skips the model", async () => {
      const model = gate();
      await expect(
        pin(
          input({
            question: "Should we merge the landing branch?",
            options: ["Merge it", "Hold"],
            earlier_user_messages: ["unrelated", "yes, merge the landing branch now"],
          }),
          model,
        ),
      ).rejects.toThrow(/^ask gate: a prior user message already answers this — already answered by an earlier user message containing: merge, landing, branch\. Act on the user's standing answer/);
      expect(model.prompts).toHaveLength(0);
      expect(await pinnedDecisions(directory, "default")).toEqual([]);
    });

    it("lets a question through when no single message covers every significant word, or none were given", async () => {
      expect(alreadyAnsweredReason("Merge the landing branch?", ["merge it", "the landing page"])).toBeUndefined();
      expect(alreadyAnsweredReason("Why?", ["anything"])).toBeUndefined();
      expect(significantWords("Should the Landing-Branch merge?")).toEqual(["landing", "branch", "merge"]);
      const model = gate();
      expect((await pin(input({ question: "Merge the landing branch?", earlier_user_messages: ["merge it"] }), model)).id).toBe(1);
      expect((await pin(input({ question: "Merge the other branch?" }), model)).id).toBe(2);
    });
  });
});

describe("the decision store", () => {
  it("defaults to ~/.cache/capability-runtime/decisions without the environment variable", () => {
    expect(decisionsDirectory({})).toMatch(/\.cache\/capability-runtime\/decisions$/);
    expect(decisionsDirectory({ [DECISIONS_DIR_ENV]: "  /tmp/x " })).toBe("/tmp/x");
  });

  it("loads a session file written before the resolved list existed and pins into it", async () => {
    await writeFile(
      join(directory, "legacy.json"),
      `${JSON.stringify({ next_id: 4, pins: [{ id: 3, question: "Older?", options: ["a"], pinned_at: "2026-01-01T00:00:00.000Z" }] })}\n`,
    );
    const model = gate();
    const output = await pin(input({ question: "Fresh?", session: "legacy" }), model);
    expect(output.id).toBe(4);
    await unpinDecision(directory, "legacy", 3);
    await expect(pin(input({ question: "older?", session: "legacy" }), model)).rejects.toThrow(/decision 3 was already answered or dismissed/);
  });

  it("keeps only the last MAX_RESOLVED resolved questions", async () => {
    const remembered = Array.from({ length: MAX_RESOLVED - 1 }, (_, index) => ({ id: index + 1, key: `q${index}?` }));
    await writeFile(join(directory, "full.json"), `${JSON.stringify({ next_id: remembered.length + 1, pins: [], resolved: remembered })}\n`);
    const first = await pinDecision(directory, "full", "Fresh one?", ["a"]);
    await unpinDecision(directory, "full", first.id);
    const read = async (): Promise<{ id: number; key: string }[]> => JSON.parse(await readFile(join(directory, "full.json"), "utf8")).resolved;
    expect(await read()).toHaveLength(MAX_RESOLVED);
    const second = await pinDecision(directory, "full", "Fresh two?", ["a"]);
    await unpinDecision(directory, "full", second.id);
    const kept = await read();
    expect(kept).toHaveLength(MAX_RESOLVED);
    expect(kept[0]).toEqual({ id: 2, key: "q1?" });
    expect(kept.at(-1)).toEqual({ id: second.id, key: "fresh two?" });
    expect((await pinDecision(directory, "full", "Q0?", ["a"])).id).toBe(second.id + 1);
    await expect(pinDecision(directory, "full", "Q1?", ["a"])).rejects.toThrow(/already answered or dismissed/);
  });

  it("names the file and the cause for a corrupt session file instead of a bare parse error", async () => {
    await writeFile(join(directory, "bad.json"), "{not json");
    await expect(pinnedDecisions(directory, "bad")).rejects.toThrow(/bad\.json is not valid JSON/);
    await writeFile(join(directory, "odd.json"), '{"next_id":"x"}');
    await expect(pinnedDecisions(directory, "odd")).rejects.toThrow(/odd\.json is not a decision pin file/);
  });

  it("maps a session name with path characters to a safe file name inside the directory", async () => {
    await pinDecision(directory, "../escape/omp:1", "Q?", ["a"]);
    expect(await readFile(join(directory, ".._escape_omp_1.json"), "utf8")).toContain('"Q?"');
  });

  it("waits for another process's lock file, then pins", async () => {
    const lock = join(directory, "locked.json.lock");
    await writeFile(lock, "");
    const release = sleep(120).then(() => rm(lock));
    const pinned = await pinDecision(directory, "locked", "Q?", ["a"]);
    await release;
    expect(pinned.id).toBe(1);
  });

  it("removes a stale lock left by a dead process", async () => {
    const lock = join(directory, "stale.json.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect((await pinDecision(directory, "stale", "Q?", ["a"])).id).toBe(1);
  });

  it("leaves no lock or temporary file behind", async () => {
    await pinDecision(directory, "clean", "Q?", ["a"]);
    await unpinDecision(directory, "clean", 1);
    const names = await Bun.$`ls ${directory}`.text();
    expect(names.trim().split("\n")).toEqual(["clean.json"]);
  });

  it("unpinning an unknown id changes nothing", async () => {
    await pinDecision(directory, "s", "Q?", ["a"]);
    expect(await unpinDecision(directory, "s", 99)).toBeUndefined();
    expect(await pinnedDecisions(directory, "s")).toHaveLength(1);
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    // The load check against omp's own zod lives outside the suite; here a tiny builder records the schema shape.
    const schema = (kind: string) => {
      const node: Record<string, unknown> = { kind };
      const chain = new Proxy(node, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
      return chain;
    };
    const zod = new Proxy({}, { get: (_t, kind) => (..._a: unknown[]) => schema(String(kind)) });
    return { zod, exec, cwd: "/", logger: {} } as never;
  }
  interface Tool {
    name: string;
    description: string;
    loadMode?: string;
    execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: unknown, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { id: number; session: string; ask_gate: { status: string } } }>;
  }
  const allowingExec: Exec = async () => ({ stdout: JSON.stringify(ALLOWING), stderr: "", code: 0, killed: false });
  const ctx = { sessionManager: { getSessionId: () => "omp-session-7" } };

  it("is essential and describes itself in 80 to 250 words, naming its sibling", () => {
    const tool = factory(pi(allowingExec)) as unknown as Tool;
    expect(tool.name).toBe("pin_decision");
    expect(tool.loadMode).toBe("essential");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(tool.description).toContain("resolve_decision");
  });

  it("pins into this omp session by default and returns the envelope the decision band reads", async () => {
    const tool = factory(pi(allowingExec)) as unknown as Tool;
    const result = await tool.execute("t1", { question: "Which database?", options: ["SQLite", "Postgres"], session: null, earlier_user_messages: null }, undefined, ctx);
    expect(result.details).toMatchObject({ id: 1, session: "omp-session-7", ask_gate: { status: "passed" } });
    // The band: JSON text with `capability` naming the tool and `output` carrying id, question, options, session.
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope.capability).toBe("pin_decision");
    expect(envelope.output).toEqual(result.details as object);
    expect(await pinnedDecisions(directory, "omp-session-7")).toHaveLength(1);
    expect(await pinnedDecisions(directory, "default")).toEqual([]);
  });

  it("honours an explicit session and falls back to `default` without an omp session", async () => {
    const tool = factory(pi(allowingExec)) as unknown as Tool;
    const named = await tool.execute("t2", { question: "A?", options: ["a"], session: "s9" }, undefined, ctx);
    expect(named.details.session).toBe("s9");
    const bare = await tool.execute("t3", { question: "B?", options: ["a"] }, undefined, undefined);
    expect(bare.details.session).toBe("default");
  });

  it("fails, as a tool error, for a refused pin", async () => {
    const exec: Exec = async () => ({ stdout: JSON.stringify(SUPPRESSING), stderr: "", code: 0, killed: false });
    const tool = factory(pi(exec)) as unknown as Tool;
    await expect(tool.execute("t4", { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] }, undefined, ctx)).rejects.toThrow(/^ask gate:/);
  });
});
