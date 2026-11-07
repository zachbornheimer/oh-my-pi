import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCrystallize } from "./crystallize.js";
import factory from "./index.js";
import { askJson, BARE_OMP_FLAGS, type Exec, type ExecResult, type ModelStep, ompModelStep, parseJsonReply } from "./omp_model.js";
import { SEED_SCHEMA, seedPrompt } from "./prompts.js";
import { type CrystallizeSpecOutput, parseSeedReply, type Seed } from "./schemas.js";
import { canonicalJson, seedDigest, seedOf, TITLE_MAX_CHARS } from "./seed.js";
import { isSessionId, type Session, saveSession } from "./session.js";

let specs = "";
let scratch = "";
let previousSpecs: string | undefined;

beforeEach(async () => {
  specs = await mkdtemp(join(tmpdir(), "specs-"));
  scratch = await mkdtemp(join(tmpdir(), "checkout-"));
  previousSpecs = process.env.SPECS_DIR;
  process.env.SPECS_DIR = specs;
});

afterEach(async () => {
  if (previousSpecs === undefined) delete process.env.SPECS_DIR;
  else process.env.SPECS_DIR = previousSpecs;
  await rm(specs, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const SESSION_ID = "reading-list-cli-abc123";

const READY_ASSESSMENT = {
  ambiguity: 0.15,
  breakdown: { goal_clarity: 1, constraint_clarity: 0.75, success_criteria_clarity: 0.75 },
  milestone: "ready" as const,
  floor_failures: [] as string[],
  ready: true,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    session_id: SESSION_ID,
    idea: "A CLI that tracks my reading list",
    created_at: "2026-10-25T12:00:00.000Z",
    updated_at: "2026-10-25T12:30:00.000Z",
    brownfield: false,
    rounds: [
      { question: "Who uses it?", target_dimension: "goal_clarity", persona: "contrarian", answer: "Only me." },
      { question: "What is out of scope?", target_dimension: "constraint_clarity", persona: "architect", answer: "Sync." },
      { question: "How do you know it works?", target_dimension: "success_criteria_clarity", persona: "researcher", answer: "Tests." },
    ],
    assessment: READY_ASSESSMENT,
    status: "ready",
    ...overrides,
  };
}

/** The interview tool creates the session directory; the fixture does the same. */
async function store(value: Session): Promise<void> {
  await mkdir(join(specs, value.session_id), { recursive: true });
  await saveSession(value);
}

const SEED_REPLY = {
  title: "Reading list CLI",
  goal: "Track the books I am reading from the command line.",
  constraints: ["The system MUST store the list in one local JSON file.", "The system MUST NOT sync to any service."],
  non_goals: ["Syncing between machines"],
  acceptance_criteria: [
    { description: "A book can be added and listed", verify_command: "bun test test/reading.test.ts" },
    { description: "README documents the commands", verify_command: "" },
  ],
  ontology: { name: "ReadingList", description: "Books being read", fields: [{ name: "title", type: "string", description: "The book's title" }] },
  deferred: ["Ratings"],
  open_questions: ["Which JSON path?"],
};

/** A fake model returning `replies[call]` (the last repeats); records every prompt. */
function fakeModel(...replies: unknown[]) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { step, prompts };
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Seed & { metadata: Record<string, unknown> };
const fixedNow = () => new Date("2026-11-06T12:00:00.000Z");

describe("crystallize_spec", () => {
  it("writes seed.json and a Spec Kit spec.md for a ready interview", async () => {
    await store(session());
    const model = fakeModel(SEED_REPLY);
    const output = await runCrystallize({ session_id: SESSION_ID }, { step: model.step, now: fixedNow });

    expect(output).toEqual({
      session_id: SESSION_ID,
      spec_path: join(specs, SESSION_ID, "spec.md"),
      seed_path: join(specs, SESSION_ID, "seed.json"),
      ambiguity: 0.15,
      gate_forced: false,
    });
    expect(model.prompts).toHaveLength(1);
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("Idea: A CLI that tracks my reading list");
    expect(prompt).toContain("Q2: What is out of scope?\nA2: Sync.");
    expect(prompt).toContain("Project context: none: new work");
    expect(prompt).toContain(JSON.stringify(SEED_SCHEMA));

    const seed = await json(output.seed_path);
    expect(seed.acceptance_criteria).toEqual([
      { id: "AC-001", description: "A book can be added and listed", verify_command: "bun test test/reading.test.ts" },
      { id: "AC-002", description: "README documents the commands" },
    ]);
    const { metadata, ...content } = seed;
    expect(metadata).toMatchObject({
      ambiguity: 0.15,
      breakdown: READY_ASSESSMENT.breakdown,
      gate_forced: false,
      interview_session_id: SESSION_ID,
      version: 1,
      created_at: "2026-11-06T12:00:00.000Z",
    });
    expect(metadata.sha256).toBe(seedDigest(content as Seed));

    const spec = await readFile(output.spec_path, "utf8");
    for (const line of [
      "# Feature Specification: Reading list CLI",
      "## User Scenarios & Testing",
      "## Requirements",
      "- **FR-001**: The system MUST store the list in one local JSON file.",
      "- **FR-002**: The system MUST NOT sync to any service.",
      "### Key Entities",
      "- `title` (string): The book's title",
      "## Success Criteria",
      "- **AC-001**: A book can be added and listed",
      "  - Verify: `bun test test/reading.test.ts`",
      "  - Verify: no command yet",
      "## Non-Goals",
      "- Syncing between machines",
      "## Assumptions & Deferred",
      "- Ratings",
      "- Which JSON path?",
      "## Interview Record",
      "**Ambiguity**: 0.15",
      "**Gate forced**: no",
      "1. **Q**: Who uses it?",
    ]) expect(spec).toContain(line);
    expect((await readdir(join(specs, SESSION_ID))).sort()).toEqual(["seed.json", "session.json", "spec.md"]);
  });

  it("accepts a reply wrapped as { Seed: ... } and drops an ontology with no name", async () => {
    await store(session());
    const wrapped = { Seed: { ...SEED_REPLY, ontology: { name: " ", description: "", fields: [] } } };
    const output = await runCrystallize({ session_id: `  ${SESSION_ID}  ` }, { step: fakeModel(wrapped).step });
    const seed = await json(output.seed_path);
    expect(seed).not.toHaveProperty("ontology");
    expect(await readFile(output.spec_path, "utf8")).not.toContain("### Key Entities");
  });

  it("refuses an interview that has not passed the gate, naming the floor failures, before any model call", async () => {
    await store(session({ status: "asking", assessment: { ...READY_ASSESSMENT, ambiguity: 0.3, ready: false, floor_failures: ["Success Criteria Clarity 0.50 < 0.70"] } }));
    const model = fakeModel(SEED_REPLY);
    await expect(runCrystallize({ session_id: SESSION_ID }, { step: model.step })).rejects.toThrow(
      /has not passed the ambiguity gate: ambiguity 0\.30 \(needs <= 0\.20\); floor failures: Success Criteria Clarity 0\.50 < 0\.70/,
    );
    expect(model.prompts).toHaveLength(0);
    expect(await readdir(join(specs, SESSION_ID))).toEqual(["session.json"]);
  });

  it("says an ungraded interview has not been graded yet", async () => {
    await store(session({ status: "asking", assessment: undefined, rounds: [] }));
    await expect(runCrystallize({ session_id: SESSION_ID }, { step: fakeModel(SEED_REPLY).step })).rejects.toThrow(/it has not been graded yet/);
  });

  it("writes an ungated interview when forced, recording gate_forced", async () => {
    await store(session({ status: "asking", assessment: undefined, rounds: [] }));
    const output = await runCrystallize({ session_id: SESSION_ID, force: true }, { step: fakeModel(SEED_REPLY).step });
    expect(output).toMatchObject({ gate_forced: true, ambiguity: null });
    expect((await json(output.seed_path)).metadata).toMatchObject({ gate_forced: true, ambiguity: null, breakdown: {} });
    const spec = await readFile(output.spec_path, "utf8");
    expect(spec).toContain("**Status**: Draft (ambiguity gate forced)");
    expect(spec).toContain("No questions were answered.");
  });

  it("never replaces a written seed: crystallizing again writes seed.v2.json and spec.v2.md", async () => {
    await store(session());
    const first = await runCrystallize({ session_id: SESSION_ID }, { step: fakeModel(SEED_REPLY).step });
    const before = await readFile(first.seed_path, "utf8");
    const second = await runCrystallize({ session_id: SESSION_ID }, { step: fakeModel(SEED_REPLY).step });
    expect(second.seed_path).toBe(join(specs, SESSION_ID, "seed.v2.json"));
    expect(second.spec_path).toBe(join(specs, SESSION_ID, "spec.v2.md"));
    expect(await readFile(first.seed_path, "utf8")).toBe(before);
    expect((await json(second.seed_path)).metadata.version).toBe(2);
  });

  it("also writes the spec into <repo>/specs/<session_id>/ of a git checkout, byte for byte", async () => {
    await store(session());
    await mkdir(join(scratch, ".git"));
    const output = await runCrystallize({ session_id: SESSION_ID, repo: scratch }, { step: fakeModel(SEED_REPLY).step });
    expect(output.repo_spec_path).toBe(join(scratch, "specs", SESSION_ID, "spec.md"));
    expect(await readFile(output.repo_spec_path!, "utf8")).toBe(await readFile(output.spec_path, "utf8"));
    expect(await readFile(join(scratch, "specs", SESSION_ID, "seed.json"), "utf8")).toBe(await readFile(output.seed_path, "utf8"));
  });

  it("FIXED: takes a version free in the repository copy too, so the repo never collides after the store was written", async () => {
    await store(session());
    await mkdir(join(scratch, ".git"));
    await mkdir(join(scratch, "specs", SESSION_ID), { recursive: true });
    await writeFile(join(scratch, "specs", SESSION_ID, "seed.json"), "{\"kept\":true}\n");
    const output = await runCrystallize({ session_id: SESSION_ID, repo: scratch }, { step: fakeModel(SEED_REPLY).step });
    expect(output.seed_path).toBe(join(specs, SESSION_ID, "seed.v2.json"));
    expect(output.repo_spec_path).toBe(join(scratch, "specs", SESSION_ID, "spec.v2.md"));
    expect(await readFile(join(scratch, "specs", SESSION_ID, "seed.json"), "utf8")).toBe("{\"kept\":true}\n");
    expect(existsSync(join(specs, SESSION_ID, "seed.json"))).toBe(false);
  });

  it("refuses a repo that is not an absolute git checkout before asking the model", async () => {
    await store(session());
    const model = fakeModel(SEED_REPLY);
    await expect(runCrystallize({ session_id: SESSION_ID, repo: scratch }, { step: model.step })).rejects.toThrow(/is not a git checkout/);
    await expect(runCrystallize({ session_id: SESSION_ID, repo: "relative/path" }, { step: model.step })).rejects.toThrow(/must be an absolute path/);
    expect(model.prompts).toHaveLength(0);
  });

  it("refuses an unknown, empty or path-like session id", async () => {
    const model = fakeModel(SEED_REPLY);
    await expect(runCrystallize({ session_id: "nope-abc123" }, { step: model.step })).rejects.toThrow(new RegExp(`no interview nope-abc123 in ${specs}`));
    await expect(runCrystallize({ session_id: "  " }, { step: model.step })).rejects.toThrow(/session_id must not be empty/);
    await expect(runCrystallize({ session_id: "../escape" }, { step: model.step })).rejects.toThrow(/is not an interview id/);
    expect(model.prompts).toHaveLength(0);
  });

  it("asks again when a constraint is not an RFC 2119 requirement, showing the model why", async () => {
    await store(session());
    const sloppy = { ...SEED_REPLY, constraints: ["works offline"] };
    const model = fakeModel(sloppy, SEED_REPLY);
    const output = await runCrystallize({ session_id: SESSION_ID }, { step: model.step });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain('constraint "works offline" must start with "The system"');
    expect((await json(output.seed_path)).constraints).toEqual(SEED_REPLY.constraints);
  });

  it("fails after three refused seeds and writes nothing", async () => {
    await store(session());
    const model = fakeModel({ ...SEED_REPLY, acceptance_criteria: [{ description: "x", verify_command: "cat <<EOF\nhi\nEOF" }] });
    await expect(runCrystallize({ session_id: SESSION_ID }, { step: model.step })).rejects.toThrow(
      /no valid reply after 3 attempts: fix the seed: AC-001 verify_command must be one line/,
    );
    expect(model.prompts).toHaveLength(3);
    expect(await readdir(join(specs, SESSION_ID))).toEqual(["session.json"]);
  });

  it("propagates a model failure and an abort without writing", async () => {
    await store(session());
    await expect(runCrystallize({ session_id: SESSION_ID }, { step: fakeModel(new Error("omp down")).step })).rejects.toThrow(/omp down/);
    const aborted = new AbortController();
    const step: ModelStep = async () => {
      aborted.abort(new Error("cancelled"));
      return JSON.stringify(SEED_REPLY);
    };
    await expect(runCrystallize({ session_id: SESSION_ID }, { step, signal: aborted.signal })).rejects.toThrow(/cancelled/);
    expect(await readdir(join(specs, SESSION_ID))).toEqual(["session.json"]);
  });
});

describe("isSessionId", () => {
  it("accepts lowercase words and digits joined by single hyphens", () => {
    for (const id of ["a", "spec", "reading-list-cli-abc123", "a-b", "0-9", "x1-y2-z3"]) expect(isSessionId(id)).toBe(true);
  });

  it("rejects empty ids, stray hyphens, other characters and path syntax", () => {
    for (const id of ["", "-", "-a", "a-", "a--b", "A", "a_b", "a b", "a/b", "../a", "a.b", "a\n", "é"]) expect(isSessionId(id)).toBe(false);
  });

  it("stays fast on a long near-miss", () => {
    const started = performance.now();
    expect(isSessionId(`${"a-".repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("the seed's rules", () => {
  const reply = () => parseSeedReply(JSON.parse(JSON.stringify(SEED_REPLY)));

  it("trims, numbers criteria AC-001.. and blanks verify commands to absent", () => {
    const seed = seedOf({ ...reply(), title: "  T  ", constraints: [" The system MAY log. ", " "].slice(0, 1), non_goals: ["", " x "] });
    expect(seed.title).toBe("T");
    expect(seed.constraints).toEqual(["The system MAY log."]);
    expect(seed.non_goals).toEqual(["x"]);
    expect(seed.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["AC-001", "AC-002"]);
    expect(seed.acceptance_criteria[1]).not.toHaveProperty("verify_command");
  });

  it.each([
    ["The system must work", /must start with "The system"/],
    ["It MUST work", /must start with "The system"/],
    ["The system works offline", /must start with "The system"/],
  ])("refuses the constraint %j", (constraint, message) => {
    expect(() => seedOf({ ...reply(), constraints: [constraint] })).toThrow(message);
  });

  it("accepts MUST NOT, SHOULD, SHOULD NOT, MAY and SHALL", () => {
    const constraints = ["The system MUST NOT x.", "The system SHOULD y.", "The system SHOULD NOT z.", "The system MAY w.", "The system SHALL v."];
    expect(seedOf({ ...reply(), constraints }).constraints).toEqual(constraints);
  });

  it("refuses a blank title or goal, a title over 80 characters, no criteria, a blank description and a continued command", () => {
    expect(() => seedOf({ ...reply(), title: " " })).toThrow(/title must not be blank/);
    expect(() => seedOf({ ...reply(), goal: "" })).toThrow(/goal must not be blank/);
    expect(() => seedOf({ ...reply(), title: "x".repeat(TITLE_MAX_CHARS + 1) })).toThrow(/title must be at most 80 characters/);
    expect(seedOf({ ...reply(), title: "x".repeat(TITLE_MAX_CHARS) }).title).toHaveLength(80);
    expect(() => seedOf({ ...reply(), acceptance_criteria: [] })).toThrow(/at least one acceptance criterion/);
    expect(() => seedOf({ ...reply(), acceptance_criteria: [{ description: " ", verify_command: "" }] })).toThrow(/AC-001 needs a description/);
    expect(() => seedOf({ ...reply(), acceptance_criteria: [{ description: "d", verify_command: "bun test \\" }] })).toThrow(/one line/);
  });

  it("digests canonical JSON: key order never changes the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
    const seed = seedOf(reply());
    expect(seedDigest(seed)).toBe(seedDigest(JSON.parse(canonicalJson(seed)) as Seed));
    expect(seedDigest(seed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks the shape of a reply field by field", () => {
    expect(() => parseSeedReply("seed")).toThrow(/JSON object/);
    expect(() => parseSeedReply({ ...SEED_REPLY, constraints: "none" })).toThrow(/constraints must be an array of strings/);
    expect(() => parseSeedReply({ ...SEED_REPLY, acceptance_criteria: [{ description: "d" }] })).toThrow(/acceptance_criteria\[0\].verify_command must be a string/);
    expect(() => parseSeedReply({ ...SEED_REPLY, ontology: { name: "n", description: "d", fields: [{ name: "f", type: "date", description: "x" }] } })).toThrow(/ontology.fields\[0\].type must be one of/);
    expect(() => parseSeedReply({ ...SEED_REPLY, ontology: undefined })).toThrow(/ontology must be an object/);
    expect(() => parseSeedReply({ ...SEED_REPLY, title: 4 })).toThrow(/title must be a string/);
  });

  it("builds a prompt that keeps the deferral and verify-command rules and a brownfield context", () => {
    const text = seedPrompt(session({ brownfield: true, context: { root: "/r/app", name: "app", entries: ["src"], readme: "An app." } }));
    expect(text).toContain("deferred: points the user explicitly chose to decide later.");
    expect(text).toContain("never a bare whole-suite command");
    expect(text).toContain("app at /r/app");
    expect(text).toContain("Ambiguity: 0.15 [ready]");
  });
});

describe("the model step", () => {
  const result = (stdout: string, code = 0): ExecResult => ({ stdout, stderr: "", code, killed: false });

  it("spawns a bare omp -p on a private prompt file and removes it afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], text: await readFile(args[1]!.slice(1), "utf8"), cwd: options?.cwd };
      return result(" reply ");
    };
    expect(await ompModelStep(exec)("the prompt")).toBe("reply");
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toBe("the prompt");
    expect(existsSync(seen!.cwd!)).toBe(false);
  });

  it("fails explicitly on a non-zero exit, a kill and empty output", async () => {
    const run = (code: number, stdout: string, killed = false): Exec => async () => ({ stdout, stderr: "bad", code, killed });
    await expect(ompModelStep(run(2, ""))("p")).rejects.toThrow(/model step exited 2: bad/);
    await expect(ompModelStep(run(-1, "", true), { timeoutMs: 2000 })("p")).rejects.toThrow(/killed after 2 s/);
    await expect(ompModelStep(run(0, " "))("p")).rejects.toThrow(/returned no text/);
  });

  it("parses fenced JSON, refuses prose, and asks again with the reason", async () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("Here: {}")).toThrow(/not JSON/);
    const asked: string[] = [];
    const value = await askJson(async (prompt) => (asked.push(prompt), asked.length === 1 ? "prose" : "[1]"), "P", (v) => v as number[]);
    expect(value).toEqual([1]);
    expect(asked[1]).toContain("Your previous reply was rejected");
  });
});

describe("the tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    const zod = new Proxy({}, { get: () => () => chain });
    return { zod, exec, cwd: "/", logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as { name: string; description: string };
    expect(tool.name).toBe("crystallize_spec");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["interview", "define_objective"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp and treats null optionals as absent", async () => {
    await store(session());
    const exec: Exec = async (command) => {
      if (command !== "omp") throw new Error(`unexpected ${command}`);
      return { stdout: JSON.stringify(SEED_REPLY), stderr: "", code: 0, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: CrystallizeSpecOutput }>;
    };
    const run = await tool.execute("t1", { session_id: SESSION_ID, force: null, repo: null }, undefined, undefined);
    expect(run.details.gate_forced).toBe(false);
    expect(JSON.parse(run.content[0]!.text)).toEqual(run.details);
    expect(existsSync(run.details.seed_path)).toBe(true);
    await expect(tool.execute("t2", { session_id: "ghost-abc123" }, undefined, undefined)).rejects.toThrow(/no interview ghost-abc123/);
  });
});
