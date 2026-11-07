import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commitsNamed, PATH, SHA } from "./commits.js";
import factory from "./index.js";
import { abortableSleep, applierAnswer, IN_FLIGHT_BUDGET, IN_FLIGHT_WAITS_MS, learn } from "./learn.js";
import { APPLY_ASK, applyPrompt, sessionPrompt } from "./learn_prompt.js";
import type { AgentStep, Exec } from "./omp_session.js";

const run = promisify(execFile);

let root: string;
let home: string;
let repo: string;
let sha: string;
let review: { conversation: string; annotated_path: string; review_path: string };

/** A real `git`, a missing `chezmoi`: sha verification runs against a temp repository, nothing else is spawned. */
const exec: Exec = async (command, args) => {
  if (command !== "git") return { stdout: "", stderr: "not installed", code: 127, killed: false };
  try {
    const { stdout, stderr } = await run("git", args);
    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: typeof failed.code === "number" ? failed.code : 1, killed: false };
  }
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "learn-test-")));
  home = join(root, "home");
  repo = join(home, "repo");
  await mkdir(repo, { recursive: true });
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(join(home, ".agents", "AGENTS.md"), "Be careful.\n");
  await run("git", ["-C", repo, "init", "-q"]);
  await writeFile(join(repo, "file.txt"), "one\n");
  // Plumbing builds the commit: no hook of this machine's git configuration runs on a fixture repository.
  await run("git", ["-C", repo, "add", "."]);
  const tree = (await run("git", ["-C", repo, "write-tree"])).stdout.trim();
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  sha = (await run("git", ["-C", repo, "commit-tree", tree, "-m", "chore: first"], { env: { ...process.env, ...identity } })).stdout.trim();
  await run("git", ["-C", repo, "update-ref", "HEAD", sha]);
  review = {
    conversation: "omp:abc",
    annotated_path: join(root, "x.annotated.json"),
    review_path: join(root, "x.review.md"),
  };
  await writeFile(review.review_path, "## Outcome\nreview text\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const answering = (text: string): AgentStep => async () => text;

describe("prompt", () => {
  it("carries the apply ask verbatim, the shared instructions and the two paths", async () => {
    const prompt = await applyPrompt(review, home);
    expect(prompt).toBe(
      [
        "# Shared operating instructions",
        "",
        "Be careful.\n",
        "",
        APPLY_ASK,
        "",
        `Review (the results): ${review.review_path}`,
        `Annotated transcript it was written from: ${review.annotated_path}`,
      ].join("\n"),
    );
    expect(APPLY_ASK).toContain("7. While something may need an experiment, all experiments need to be run at the end.");
  });

  it("puts the applier's instructions first, then the apply message, with the shared block once", async () => {
    const prompt = await sessionPrompt(review, home);
    expect(prompt.startsWith("You implement the suggestions of a forensics review")).toBe(true);
    expect(prompt.match(/# Shared operating instructions/g)?.length).toBe(1);
    expect(prompt.endsWith(`Annotated transcript it was written from: ${review.annotated_path}`)).toBe(true);
  });
});

describe("applierAnswer", () => {
  const budget = new Error("applier session exited 1: 402 in_flight_budget_exhausted");

  it("retries the in-flight-budget error after 60, 120 and 240 s, then returns the answer", async () => {
    let calls = 0;
    const step: AgentStep = async () => {
      calls += 1;
      if (calls <= 3) throw budget;
      return "done";
    };
    const waits: number[] = [];
    const answer = await applierAnswer(step, "p", { sleep: async (ms) => void waits.push(ms) });
    expect(answer).toBe("done");
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(IN_FLIGHT_WAITS_MS).toEqual([60_000, 120_000, 240_000]);
  });

  it("throws the budget error after the last wait and never retries another error", async () => {
    let calls = 0;
    const always: AgentStep = async () => {
      calls += 1;
      throw budget;
    };
    await expect(applierAnswer(always, "p", { waitsMs: [0, 0, 0] })).rejects.toThrow("in_flight_budget_exhausted");
    expect(calls).toBe(4);
    calls = 0;
    const other: AgentStep = async () => {
      calls += 1;
      throw new Error("model step exited 2: boom");
    };
    await expect(applierAnswer(other, "p", { waitsMs: [0, 0, 0] })).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("recognises both router phrasings", () => {
    expect(IN_FLIGHT_BUDGET.test("402 in_flight_budget_exhausted")).toBe(true);
    expect(IN_FLIGHT_BUDGET.test("you exceed your available credits given your current in-flight requests")).toBe(true);
    expect(IN_FLIGHT_BUDGET.test("rate limited")).toBe(false);
  });

  it("a wait ends early when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("sha verification", () => {
  it("matches shas and paths as prose carries them", () => {
    // A sha needs a letter and a digit: a bare number is a count, an all-letter word is a word.
    expect("fixed in abc1234 and 12345678 (a count: 1234567) and deadbeef".match(SHA)).toEqual(["abc1234"]);
    expect("see ~/repo/file.txt, and /Users/x/y and".match(PATH)).toEqual(["~/repo/file.txt", "/Users/x/y"]);
  });

  it("keeps the commits a named repository holds and reports the rest as unverified", async () => {
    const answer = `Committed ${sha} in ~/repo. Also claimed 1badc0de2 which nothing holds.`;
    const { commits, unverified } = await commitsNamed(answer, exec, { home });
    expect(commits).toEqual([{ repo, sha }]);
    expect(unverified).toEqual(["1badc0de2"]);
  });

  it("finds a repository through a file path inside it", async () => {
    const { commits } = await commitsNamed(`${sha} touched ~/repo/file.txt`, exec, { home });
    expect(commits).toEqual([{ repo, sha }]);
  });

  it("does not verify a sha when no repository is named and chezmoi is absent", async () => {
    const { commits, unverified } = await commitsNamed(`committed ${sha}`, exec, { home });
    expect(commits).toEqual([]);
    expect(unverified).toEqual([sha]);
  });

  it("uses the chezmoi source repository when chezmoi is installed", async () => {
    const gitOnly: Exec = exec;
    const withChezmoi: Exec = async (command, args, options) =>
      command === "chezmoi" ? { stdout: `${repo}\n`, stderr: "", code: 0, killed: false } : gitOnly(command, args, options);
    const { commits } = await commitsNamed(`committed ${sha}`, withChezmoi, { home });
    expect(commits).toEqual([{ repo, sha }]);
  });

  it("treats a spawn failure as not holding the commit", async () => {
    const broken: Exec = async () => {
      throw new Error("spawn ENOENT");
    };
    const { commits, unverified } = await commitsNamed(`${sha} in ~/repo`, broken, { home });
    expect(commits).toEqual([]);
    expect(unverified).toEqual([sha]);
  });
});

describe("learn", () => {
  it("returns the answer with verified commits and unverified shas, and no memory_ref", async () => {
    const answer = `Landed ${sha} in ~/repo; also 0badbeef1 (not real).`;
    const result = await learn(review, { step: answering(answer), exec, home, waitsMs: [0, 0, 0] });
    expect(result).toEqual({
      conversation: "omp:abc",
      review_path: review.review_path,
      answer_markdown: answer,
      commits: [{ repo, sha }],
      unverified_shas: ["0badbeef1"],
    });
    expect("memory_ref" in result).toBe(false);
  });

  it("sends the applier the instructions, the ask and both paths", async () => {
    let prompt = "";
    await learn(review, {
      step: async (p) => {
        prompt = p;
        return "nothing to commit";
      },
      exec,
      home,
      waitsMs: [0],
    });
    expect(prompt).toContain("You implement the suggestions of a forensics review");
    expect(prompt).toContain(`Review (the results): ${review.review_path}`);
    expect(prompt).toContain(`Annotated transcript it was written from: ${review.annotated_path}`);
  });

  it("retries the in-flight-budget refusal with the injected waits", async () => {
    let calls = 0;
    const step: AgentStep = async () => {
      calls += 1;
      if (calls < 3) throw new Error("402 in_flight_budget_exhausted");
      return "ok";
    };
    const result = await learn({ ...review, report_markdown: "text" }, { step, exec, home, waitsMs: [0, 0, 0] });
    expect(result.answer_markdown).toBe("ok");
    expect(calls).toBe(3);
  });

  it("fails before paying for a session when the review file is missing or blank", async () => {
    let calls = 0;
    const step: AgentStep = async () => {
      calls += 1;
      return "x";
    };
    await expect(learn({ ...review, review_path: join(root, "nope.md") }, { step, exec, home })).rejects.toThrow("no review at");
    await writeFile(review.review_path, "  \n");
    await expect(learn(review, { step, exec, home })).rejects.toThrow("missing or blank");
    expect(calls).toBe(0);
  });

  it("fails on an empty answer and on a failing session", async () => {
    await expect(learn(review, { step: answering("  "), exec, home })).rejects.toThrow("empty answer");
    const failing: AgentStep = async () => {
      throw new Error("applier session exited 1: boom");
    };
    await expect(learn(review, { step: failing, exec, home, waitsMs: [0] })).rejects.toThrow("boom");
  });
});

/** A chainable stand-in for `pi.zod`: enough to build the schema. */
function stubZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}

describe("tool", () => {
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined) => Promise<unknown>;
  };
  const tool = () => factory({ zod: stubZod(), exec, cwd: root } as never) as Tool;

  it("is named learn and its description is 80 to 250 words naming the side effects and the omission", () => {
    const { name, description } = tool();
    expect(name).toBe("learn");
    const words = description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(description).toContain("SIDE EFFECTS");
    expect(description).toContain("does NOT record the learning in session memory");
  });

  it("refuses a blank field before any session starts", async () => {
    await expect(
      tool().execute("1", { conversation: " ", annotated_path: "a", review_path: "b" }, undefined, undefined),
    ).rejects.toThrow("`conversation` is blank");
  });
});
