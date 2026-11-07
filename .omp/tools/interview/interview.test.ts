import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambiguityOf, assess, floorFailures, isReady, milestoneOf } from "./ambiguity.js";
import { type Candidate, knownDimension, selectCandidate } from "./candidates.js";
import { firstProse } from "./context.js";
import factory from "./index.js";
import { runInterview, type InterviewInput, type InterviewOutput } from "./interview.js";
import {
  askJson,
  BARE_OMP_FLAGS,
  type Exec,
  type ExecResult,
  mapLimit,
  type ModelStep,
  ompModelStep,
  parseJsonReply,
} from "./omp_model.js";
import { gradingPrompt, parseGrading } from "./prompts.js";
import { isSessionId, loadSession, sessionDirectory, slugOf } from "./session.js";

let specs = "";
let previousSpecs: string | undefined;

beforeEach(async () => {
  specs = await mkdtemp(join(tmpdir(), "specs-"));
  previousSpecs = process.env.SPECS_DIR;
  process.env.SPECS_DIR = specs;
});

afterEach(async () => {
  if (previousSpecs === undefined) delete process.env.SPECS_DIR;
  else process.env.SPECS_DIR = previousSpecs;
  await rm(specs, { recursive: true, force: true });
});

const PERSONAS = ["contrarian", "architect", "researcher"] as const;

/** A fake model: personas propose `targets[persona]`, the grader gives every dimension `levels[dimension] ?? 4`. */
function fakeModel(
  options: {
    targets?: Record<string, string>;
    levels?: Record<string, number>;
    failing?: string[];
    gradeReply?: (prompt: string) => string;
  } = {},
) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const persona = /## Persona Lens: (\w+)/.exec(prompt)?.[1];
    if (persona !== undefined) {
      if (options.failing?.includes(persona)) throw new Error(`${persona} is down`);
      return JSON.stringify({
        question: `What does the ${persona} need to know?`,
        target_dimension: options.targets?.[persona] ?? "goal_clarity",
      });
    }
    if (options.gradeReply !== undefined) return options.gradeReply(prompt);
    const dimensions = [...prompt.matchAll(/^## (\w+_clarity)$/gm)].map((match) => match[1]!);
    return JSON.stringify(Object.fromEntries(dimensions.map((dimension) => [dimension, options.levels?.[dimension] ?? 4])));
  };
  const graded = () => prompts.filter((prompt) => prompt.startsWith("Grade this software idea"));
  const asked = () => prompts.filter((prompt) => prompt.includes("## Persona Lens:"));
  return { step, prompts, graded, asked };
}

const result = (stdout: string, code = 0): ExecResult => ({ stdout, stderr: "", code, killed: false });
const noExec: Exec = async () => {
  throw new Error("exec must not run");
};

async function turn(input: InterviewInput, model: { step: ModelStep }, exec: Exec = noExec, extra: { cwd?: string; home?: string } = {}) {
  // Standing in $HOME is greenfield without asking git, so the default start needs no exec.
  const home = extra.home ?? "/nowhere";
  return runInterview(input, { step: model.step, exec, cwd: extra.cwd ?? home, home });
}

async function stored(sessionId: string) {
  return JSON.parse(await readFile(join(specs, sessionId, "session.json"), "utf8")) as {
    status: string;
    rounds: { question: string; target_dimension: string; persona: string; answer?: string }[];
  };
}

const CLEAR = { goal_clarity: 1, constraint_clarity: 1, success_criteria_clarity: 1, context_clarity: 1 };

describe("the ambiguity gate", () => {
  it("opens at exactly 0.2 and stays shut at 0.2001", () => {
    expect(isReady(0.2, [])).toBe(true);
    expect(isReady(0.2001, [])).toBe(false);
    expect(isReady(0.1, ["Goal Clarity 0.50 < 0.75"])).toBe(false);
  });

  it("weighs greenfield goal .40 / constraints .30 / success .30 and rounds to 4 places", () => {
    expect(ambiguityOf(CLEAR, false)).toBe(0);
    expect(ambiguityOf({ goal_clarity: 0.8, constraint_clarity: 0.8, success_criteria_clarity: 0.8 }, false)).toBe(0.2);
    expect(ambiguityOf({ goal_clarity: 0, constraint_clarity: 1, success_criteria_clarity: 1 }, false)).toBe(0.4);
  });

  it("weighs brownfield goal .35 / constraints .25 / success .25 / context .15", () => {
    expect(ambiguityOf({ ...CLEAR, context_clarity: 0 }, true)).toBe(0.15);
    expect(ambiguityOf({ ...CLEAR, goal_clarity: 0 }, true)).toBe(0.35);
  });

  it.each([
    ["goal_clarity", 0.7, false, "Goal Clarity 0.70 < 0.75"],
    ["constraint_clarity", 0.6, false, "Constraint Clarity 0.60 < 0.65"],
    ["success_criteria_clarity", 0.6, false, "Success Criteria Clarity 0.60 < 0.70"],
    ["context_clarity", 0.5, true, "Context Clarity 0.50 < 0.60"],
  ] as const)("keeps the gate shut when %s alone misses its floor", (dimension, clarity, brownfield, failure) => {
    const assessed = assess({ ...CLEAR, [dimension]: clarity }, brownfield);
    expect(assessed.floor_failures).toEqual([failure]);
    expect(assessed.ready).toBe(false);
  });

  it("reads each floor at its boundary as met", () => {
    expect(floorFailures({ goal_clarity: 0.75, constraint_clarity: 0.65, success_criteria_clarity: 0.7 }, false)).toEqual([]);
  });

  it("asks for context only when brownfield, and names an ungraded dimension as missing", () => {
    expect(floorFailures({ goal_clarity: 1, constraint_clarity: 1, success_criteria_clarity: 1 }, false)).toEqual([]);
    expect(floorFailures({ goal_clarity: 1, constraint_clarity: 1, success_criteria_clarity: 1 }, true)).toEqual([
      "Context Clarity missing (< 0.60)",
    ]);
  });

  it("names the milestone a score has reached", () => {
    expect([0.2, 0.25, 0.3, 0.35, 0.4, 0.9].map(milestoneOf)).toEqual([
      "ready",
      "refined",
      "refined",
      "progress",
      "progress",
      "initial",
    ]);
  });
});

describe("the question panel's pick", () => {
  const candidate = (persona: Candidate["persona"], target_dimension: Candidate["target_dimension"]): Candidate => ({
    persona,
    question: `${persona}?`,
    target_dimension,
  });

  it("takes the candidate aimed at the least clear dimension, whatever its persona", () => {
    const picked = selectCandidate(
      [candidate("contrarian", "goal_clarity"), candidate("researcher", "success_criteria_clarity")],
      { goal_clarity: 0.9, success_criteria_clarity: 0.4 },
    );
    expect(picked.persona).toBe("researcher");
  });

  it("breaks a tie by persona order: contrarian, architect, researcher", () => {
    const tied = [candidate("researcher", "goal_clarity"), candidate("architect", "goal_clarity")];
    expect(selectCandidate(tied, { goal_clarity: 0.5 }).persona).toBe("architect");
  });

  it("ranks an unknown or ungraded dimension last and picks by persona order before the first grading", () => {
    expect(selectCandidate([candidate("contrarian", ""), candidate("researcher", "goal_clarity")], { goal_clarity: 0.9 }).persona).toBe("researcher");
    expect(selectCandidate([candidate("researcher", "goal_clarity"), candidate("contrarian", "constraint_clarity")], {}).persona).toBe("contrarian");
    expect(knownDimension(" goal_clarity ")).toBe("goal_clarity");
    expect(knownDimension("nonsense")).toBe("");
  });
});

describe("interview turns", () => {
  it("starts a greenfield interview in $SPECS_DIR and asks the contrarian's question without grading", async () => {
    const model = fakeModel();
    const started = await turn({ idea: "A CLI that tracks my reading list" }, model);
    expect(started).toMatchObject({
      status: "asking",
      question: "What does the contrarian need to know?",
      target_dimension: "goal_clarity",
      round: 0,
      floor_failures: [],
      brownfield: false,
    });
    expect(started.session_id).toMatch(/^a-cli-that-tracks-my-reading-[a-z0-9]{6}$/);
    expect(started.store_dir).toBe(join(specs, started.session_id));
    expect(started.ambiguity).toBeUndefined();
    expect(model.graded()).toHaveLength(0);
    expect(model.asked().map((prompt) => /## Persona Lens: (\w+)/.exec(prompt)![1]).sort()).toEqual(["architect", "contrarian", "researcher"]);
    const session = await stored(started.session_id);
    expect(session.rounds).toEqual([{ question: started.question!, target_dimension: "goal_clarity", persona: "contrarian" }]);
    expect(session.status).toBe("asking");
    expect((await readdir(join(specs, started.session_id))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("grades nothing before the third answer, then opens the gate when the model finds it clear", async () => {
    const model = fakeModel();
    const { session_id } = await turn({ idea: "reading list CLI" }, model);
    const first = await turn({ session_id, answer: "Only me, on macOS." }, model);
    const second = await turn({ session_id, answer: "Books only; no sync." }, model);
    expect([first.round, second.round]).toEqual([1, 2]);
    expect(model.graded()).toHaveLength(0);

    const third = await turn({ session_id, answer: "Done when `reading add` and `reading list` pass their tests." }, model);
    expect(model.graded()).toHaveLength(1);
    const prompt = model.graded()[0]!;
    expect(prompt).toContain("## goal_clarity");
    expect(prompt).toContain("## constraint_clarity");
    expect(prompt).toContain("## success_criteria_clarity");
    expect(prompt).not.toContain("## context_clarity");
    expect(prompt).toContain("A3: Done when `reading add`");
    expect(prompt).not.toContain("Project context:");
    expect(third).toMatchObject({ status: "ready", round: 3, ambiguity: 0, milestone: "ready", floor_failures: [] });
    expect(third.question).toBeUndefined();
    expect((await stored(session_id)).status).toBe("ready");
  });

  it("keeps asking after round 3 while a floor fails, aiming the next question at the least clear dimension", async () => {
    const model = fakeModel({ levels: { goal_clarity: 2 }, targets: { contrarian: "success_criteria_clarity", architect: "goal_clarity", researcher: "constraint_clarity" } });
    const { session_id } = await turn({ idea: "reading list CLI" }, model);
    for (const answer of ["one", "two"]) await turn({ session_id, answer }, model);
    const graded = await turn({ session_id, answer: "three" }, model);
    expect(graded).toMatchObject({ status: "asking", round: 3, ambiguity: 0.2, milestone: "ready", floor_failures: ["Goal Clarity 0.50 < 0.75"] });
    expect(graded.question).toBe("What does the architect need to know?");
    expect(graded.breakdown).toEqual({ goal_clarity: 0.5, constraint_clarity: 1, success_criteria_clarity: 1 });
  });

  it("reads a fractional level between two levels", async () => {
    const model = fakeModel({ gradeReply: () => JSON.stringify({ goal_clarity: 3.5, constraint_clarity: 3.5, success_criteria_clarity: 3.5 }) });
    const { session_id } = await turn({ idea: "reading list CLI" }, model);
    for (const answer of ["one", "two"]) await turn({ session_id, answer }, model);
    const graded = await turn({ session_id, answer: "three" }, model);
    expect(graded).toMatchObject({ status: "ready", ambiguity: 0.125, breakdown: { goal_clarity: 0.875 } });
  });

  it("grades context clarity with brownfield weights when the interview has a codebase", async () => {
    const model = fakeModel({ levels: { context_clarity: 2 } });
    const context = { root: "/repo/app", name: "app", entries: ["src", "README.md"], readme: "A reading app." };
    const started = await turn({ idea: "add tags to books", context }, model);
    expect(started.brownfield).toBe(true);
    expect(model.asked()[0]).toContain("app at /repo/app");
    for (const answer of ["one", "two"]) await turn({ session_id: started.session_id, answer }, model);
    const graded = await turn({ session_id: started.session_id, answer: "three" }, model);
    expect(model.graded()[0]).toContain("## context_clarity");
    expect(model.graded()[0]).toContain("README: A reading app.");
    expect(graded).toMatchObject({ status: "asking", ambiguity: 0.075, floor_failures: ["Context Clarity 0.50 < 0.60"] });
  });

  it("drops a persona that fails and asks with the others; fails only when all three fail", async () => {
    const started = await turn({ idea: "reading list CLI" }, fakeModel({ failing: ["contrarian"], targets: { architect: "goal_clarity" } }));
    expect(started.question).toBe("What does the architect need to know?");
    expect((await stored(started.session_id)).rounds[0]!.persona).toBe("architect");

    const dead = fakeModel({ failing: [...PERSONAS] });
    await expect(turn({ idea: "nothing works" }, dead)).rejects.toThrow(/no persona proposed a question: contrarian: contrarian is down; architect/);
    expect(await readdir(specs)).toHaveLength(1);
  });

  it("asks again with the reason when a persona reply is blank, and drops it after three bad replies", async () => {
    let calls = 0;
    const step: ModelStep = async (prompt) => {
      if (prompt.includes("## Persona Lens: contrarian")) {
        calls += 1;
        return JSON.stringify({ question: "   ", target_dimension: "goal_clarity" });
      }
      return JSON.stringify({ question: "Who owns it?", target_dimension: "bogus_dimension" });
    };
    const started = await turn({ idea: "reading list CLI" }, { step });
    expect(calls).toBe(3);
    expect(started.question).toBe("Who owns it?");
    expect(started.target_dimension).toBe("");
  });

  it("fails the turn, leaving the answer unrecorded, when grading replies are never valid", async () => {
    const ok = fakeModel();
    const { session_id } = await turn({ idea: "reading list CLI" }, ok);
    for (const answer of ["one", "two"]) await turn({ session_id, answer }, ok);
    const bad = fakeModel({ gradeReply: () => JSON.stringify({ goal_clarity: 9, constraint_clarity: 1, success_criteria_clarity: 1 }) });
    await expect(turn({ session_id, answer: "three" }, bad)).rejects.toThrow(/no valid reply after 3 attempts: goal_clarity must be a number from 0 to 4, got 9/);
    expect(bad.graded()).toHaveLength(3);
    expect(bad.graded()[1]).toContain("Your previous reply was rejected");
    const session = await stored(session_id);
    expect(session.rounds.at(-1)!.answer).toBeUndefined();
  });
});

describe("refusals", () => {
  it("refuses to answer an interview that does not exist, naming the store", async () => {
    await expect(turn({ session_id: "nope-abc123", answer: "hi" }, fakeModel())).rejects.toThrow(new RegExp(`no interview nope-abc123 in ${specs}`));
  });

  it("refuses to start without an idea, to continue without an answer, and to mix the two", async () => {
    await expect(turn({}, fakeModel())).rejects.toThrow(/idea is required to start an interview/);
    await expect(turn({ idea: "  " }, fakeModel())).rejects.toThrow(/idea is required/);
    await expect(turn({ session_id: "x-abc123" }, fakeModel())).rejects.toThrow(/answer is required to continue/);
    await expect(turn({ session_id: "x-abc123", answer: "  " }, fakeModel())).rejects.toThrow(/answer is required to continue/);
    await expect(turn({ idea: "x", answer: "y" }, fakeModel())).rejects.toThrow(/answer needs the session_id/);
    await expect(turn({ session_id: "x-abc123", answer: "y", idea: "z" }, fakeModel())).rejects.toThrow(/idea starts a new interview/);
  });

  it("refuses a session id that could name anything outside the store", async () => {
    for (const id of ["../etc", "a/b", "UPPER", "", "-x", "a--b"]) {
      expect(() => sessionDirectory(id)).toThrow(/is not an interview id/);
    }
    await expect(turn({ session_id: "../../etc", answer: "y" }, fakeModel())).rejects.toThrow(/is not an interview id/);
  });

  it("accepts exactly the ids the former pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/ accepted", () => {
    const table: [string, boolean][] = [
      ["a", true], ["x-abc123", true], ["reading-list-cli-k3j9zz", true], ["0", true], ["a-1-b-2", true],
      ["", false], ["-", false], ["-x", false], ["x-", false], ["a--b", false], ["A", false], ["a_b", false],
      ["a b", false], ["a/b", false], ["../etc", false], ["a\nb", false], ["a-b\n", false], ["é", false],
    ];
    for (const [id, accepted] of table) expect([id, isSessionId(id)]).toEqual([id, accepted]);
    expect(isSessionId(`${"a-".repeat(50_000)}!`)).toBe(false);
  });

  it("refuses to continue a ready interview and one with no pending question", async () => {
    const model = fakeModel();
    const { session_id } = await turn({ idea: "reading list CLI" }, model);
    for (const answer of ["one", "two", "three"]) await turn({ session_id, answer }, model);
    await expect(turn({ session_id, answer: "more" }, model)).rejects.toThrow(/already ready \(ambiguity 0\): crystallize it with crystallize_spec/);

    const orphan = join(specs, "orphan-abc123");
    await mkdir(orphan);
    await writeFile(
      join(orphan, "session.json"),
      JSON.stringify({ version: 1, session_id: "orphan-abc123", idea: "x", created_at: "t", updated_at: "t", brownfield: false, rounds: [], status: "asking" }),
    );
    await expect(turn({ session_id: "orphan-abc123", answer: "hi" }, model)).rejects.toThrow(/has no pending question to answer/);
  });

  it("names an unreadable stored session instead of crashing on it", async () => {
    const broken = join(specs, "broken-abc123");
    await mkdir(broken);
    await writeFile(join(broken, "session.json"), JSON.stringify({ version: 2 }));
    await expect(loadSession("broken-abc123")).rejects.toThrow(/interview broken-abc123 is unreadable .*version 2 is not supported/);
    await writeFile(join(broken, "session.json"), "{not json");
    await expect(loadSession("broken-abc123")).rejects.toThrow(/is unreadable/);
  });

  it("rejects a malformed context", async () => {
    await expect(turn({ idea: "x", context: { root: "/r" } }, fakeModel())).rejects.toThrow(/context.name must be a string/);
    await expect(turn({ idea: "x", context: "nope" }, fakeModel())).rejects.toThrow(/context must be an object/);
  });
});

describe("where an interview starts decides brownfield", () => {
  const HOME = "/home/zach";
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-"));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "README.md"), "# reading\n\nA CLI that tracks the books I am reading.\n");
    await writeFile(join(repo, "package.json"), "{}");
    await writeFile(join(repo, ".gitignore"), "");
  });
  afterEach(() => rm(repo, { recursive: true, force: true }));

  const gitExec = (top: string, runs: string[][] = []): Exec => async (command, args) => {
    runs.push([command, ...args]);
    return command === "git" && args.includes("rev-parse") ? result(`${top}\n`) : result("", 1);
  };

  it("treats ~ as greenfield without asking git", async () => {
    const started = await turn({ idea: "x", cwd: HOME }, fakeModel(), noExec, { home: HOME });
    expect(started.brownfield).toBe(false);
  });

  it("treats a directory inside a git repository as brownfield, with the repository's light context", async () => {
    const runs: string[][] = [];
    const started = await turn({ idea: "add tags", cwd: join(repo, "src") }, fakeModel(), gitExec(repo, runs), { home: HOME });
    expect(started.brownfield).toBe(true);
    expect(runs).toEqual([["git", "-C", join(repo, "src"), "rev-parse", "--path-format=absolute", "--show-toplevel"]]);
    const session = JSON.parse(await readFile(join(specs, started.session_id, "session.json"), "utf8")) as { context: unknown };
    expect(session.context).toEqual({
      root: repo,
      name: repo.split("/").at(-1)!,
      entries: ["README.md", "package.json", "src"],
      readme: "A CLI that tracks the books I am reading.",
    });
  });

  it("defaults to the directory the tool runs in", async () => {
    const started = await turn({ idea: "x" }, fakeModel(), gitExec(repo), { cwd: repo, home: HOME });
    expect(started.brownfield).toBe(true);
  });

  it("treats a directory outside any repository, or inside a repository that is $HOME itself, as greenfield", async () => {
    const outside: Exec = async () => result("fatal: not a git repository", 128);
    expect((await turn({ idea: "x", cwd: "/tmp/scratch" }, fakeModel(), outside, { home: HOME })).brownfield).toBe(false);
    expect((await turn({ idea: "y", cwd: `${HOME}/notes` }, fakeModel(), gitExec(HOME), { home: HOME })).brownfield).toBe(false);
  });

  it("reads a named atask project's home instead of the cwd", async () => {
    const runs: string[][] = [];
    const exec: Exec = async (command, args) => {
      runs.push([command, ...args]);
      return result(JSON.stringify({ ok: true, result: [{ id: "p-1", name: "reading", root_path: repo }] }));
    };
    const started = await turn({ idea: "x", cwd: HOME, project: "reading" }, fakeModel(), exec, { home: HOME });
    expect(started.brownfield).toBe(true);
    expect(runs).toEqual([["env", "ATASK_OUTPUT=json", "atask", "projects"]]);
  });

  it("falls back to the conventional home of a project with no registered path", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-"));
    try {
      await mkdir(join(home, "Developer/Personal/reading"), { recursive: true });
      const exec: Exec = async () => result(JSON.stringify({ ok: true, result: [{ id: "p-1", name: "reading" }, { id: "p-2", name: "sah:ops" }] }));
      expect((await turn({ idea: "x", project: "p-1" }, fakeModel(), exec, { home })).brownfield).toBe(true);
      await expect(turn({ idea: "x", project: "sah:ops" }, fakeModel(), exec, { home })).rejects.toThrow(/atask project sah:ops has no home directory/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a project atask does not know, naming the known ones, and an unreadable registry", async () => {
    const known: Exec = async () => result(JSON.stringify({ ok: true, result: [{ id: "p-1", name: "reading" }] }));
    await expect(turn({ idea: "x", project: "nope" }, fakeModel(), known)).rejects.toThrow(/project "nope" is not an atask project: one of reading/);
    await expect(turn({ idea: "x", project: "reading" }, fakeModel(), async () => result("oops"))).rejects.toThrow(/did not print the project registry/);
    await expect(turn({ idea: "x", project: "reading" }, fakeModel(), async () => ({ stdout: "", stderr: "boom", code: 2, killed: false }))).rejects.toThrow(/`atask projects` failed \(exit 2\): boom/);
  });

  it("leaves a continued interview's kind alone: it never asks git again", async () => {
    const model = fakeModel();
    const started = await turn({ idea: "x", cwd: repo }, model, gitExec(repo), { home: HOME });
    const next = await turn({ session_id: started.session_id, answer: "yes", cwd: "/tmp" }, model, noExec);
    expect(next.brownfield).toBe(true);
  });

  it("reads the first prose of a README, skipping headings, badges, fences and front matter", () => {
    expect(firstProse("---\ntitle: x\n---\n# T\n\n[![b](u)](v)\n\n```sh\nnpm i\n```\n\nReal words\nacross lines.\n")).toBe("Real words across lines.");
    expect(firstProse("# only a heading\n")).toBe("");
    expect(firstProse(`${"w ".repeat(300)}`).length).toBeLessThanOrEqual(240);
  });
});

describe("the model step", () => {
  it("spawns a bare omp -p on a private prompt file and removes it afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string; timeout?: number } | undefined;
    const exec: Exec = async (command, args, options) => {
      const file = args[1]!.slice(1);
      seen = { args: [command, ...args], text: await readFile(file, "utf8"), cwd: options?.cwd, timeout: options?.timeout };
      return result("  the reply \n");
    };
    expect(await ompModelStep(exec)("the prompt")).toBe("the reply");
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args[2]).toMatch(/^@.*prompt\.md$/);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toBe("the prompt");
    expect(seen!.timeout).toBe(300_000);
    expect(existsSync(seen!.cwd!)).toBe(false);
  });

  it("fails explicitly on a non-zero exit, a kill, empty output and an aborted signal, and still cleans up", async () => {
    let directory = "";
    const record = (code: number, stdout: string, killed = false): Exec => async (_c, args) => {
      directory = args[1]!.slice(1).replace(/\/prompt\.md$/, "");
      return { stdout, stderr: code === 0 ? "" : "bad flag", code, killed };
    };
    await expect(ompModelStep(record(2, ""))("p")).rejects.toThrow(/model step exited 2: bad flag/);
    expect(existsSync(directory)).toBe(false);
    await expect(ompModelStep(record(-1, "", true), { timeoutMs: 5000 })("p")).rejects.toThrow(/killed after 5 s/);
    await expect(ompModelStep(record(0, "  \n"))("p")).rejects.toThrow(/returned no text/);
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(ompModelStep(noExec)("p", aborted.signal)).rejects.toThrow(/stop/);
  });

  it("parses a JSON reply, with or without one wrapping code fence, and refuses prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("Sure! Here it is: {\"a\":1}")).toThrow(/the reply is not JSON/);
  });

  it("asks again with the reason until the reply validates, then returns it", async () => {
    const replies = ["prose", '{"n":"x"}', '{"n":7}'];
    const asked: string[] = [];
    const value = await askJson(
      async (prompt) => {
        asked.push(prompt);
        return replies[asked.length - 1]!;
      },
      "P",
      (v) => {
        const n = (v as { n: unknown }).n;
        if (typeof n !== "number") throw new Error("n must be a number");
        return n;
      },
    );
    expect(value).toBe(7);
    expect(asked[0]).toBe("P");
    expect(asked[1]).toContain("the reply is not JSON");
    expect(asked[2]).toContain("n must be a number");
  });

  it("runs work with at most `limit` in flight and keeps result order", async () => {
    const gates = [1, 2, 3, 4, 5].map(() => Promise.withResolvers<void>());
    const started: number[] = [];
    let flying = 0;
    let peak = 0;
    const pending = mapLimit([1, 2, 3, 4, 5], 2, async (n, index) => {
      flying += 1;
      peak = Math.max(peak, flying);
      started.push(n);
      await gates[index]!.promise;
      flying -= 1;
      return n * 10;
    });
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    for (const gate of [...gates].reverse()) gate.resolve();
    expect(await pending).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe("grading prompt and reply", () => {
  it("states the rubric and the deferral rule, and refuses a missing or off-scale level", () => {
    const session = { version: 1 as const, session_id: "s", idea: "idea", created_at: "", updated_at: "", brownfield: false, rounds: [], status: "asking" as const };
    const prompt = gradingPrompt(session, ["goal_clarity"]);
    expect(prompt).toContain("Do NOT lower the score for intentionally deferred items");
    expect(prompt).toContain("  4: Perfectly specific. The goal is stated so exactly that two builders would build the same thing.");
    expect(parseGrading({ goal_clarity: 3 }, ["goal_clarity"])).toEqual({ goal_clarity: 0.75 });
    expect(() => parseGrading({}, ["goal_clarity"])).toThrow(/goal_clarity must be a number from 0 to 4/);
    expect(() => parseGrading({ goal_clarity: -1 }, ["goal_clarity"])).toThrow(/got -1/);
    expect(() => parseGrading({ goal_clarity: "4" }, ["goal_clarity"])).toThrow(/got "4"/);
    expect(() => parseGrading([], ["goal_clarity"])).toThrow(/JSON object/);
  });

  it("slugs an idea to at most six words and 40 characters, or `spec` when it has none", () => {
    expect(slugOf("A CLI that tracks my reading list, please!")).toBe("a-cli-that-tracks-my-reading");
    expect(slugOf("!!!")).toBe("spec");
    expect(slugOf("x".repeat(80)).length).toBe(40);
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

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(noExec)) as { name: string; description: string };
    expect(tool.name).toBe("interview");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["crystallize_spec", "identify_goals", "define_objective"]) expect(tool.description).toContain(sibling);
  });

  it("runs a whole interview through execute with a fake omp, writing only under $SPECS_DIR", async () => {
    const model = fakeModel();
    const calls: string[] = [];
    const exec: Exec = async (command, args, options) => {
      calls.push(command);
      if (command === "omp") {
        const prompt = await readFile(args[1]!.slice(1), "utf8");
        return result(await model.step(prompt));
      }
      return result("fatal: not a git repository", 128);
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: InterviewOutput }>;
    };
    const first = await tool.execute("t1", { idea: "reading list CLI", answer: null, session_id: null, cwd: "/tmp/x", project: null, context: null }, undefined, undefined);
    expect(first.details.status).toBe("asking");
    expect(JSON.parse(first.content[0]!.text)).toEqual(first.details);
    const next = await tool.execute("t2", { session_id: first.details.session_id, answer: "me" }, undefined, undefined);
    expect(next.details.round).toBe(1);
    expect(calls.filter((c) => c === "omp")).toHaveLength(6);
    expect(await readdir(specs)).toEqual([first.details.session_id]);
    await expect(tool.execute("t3", { idea: null, session_id: null }, undefined, undefined)).rejects.toThrow(/idea is required/);
  });
});
