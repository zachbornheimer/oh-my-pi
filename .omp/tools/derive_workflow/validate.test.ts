import { describe, expect, it } from "bun:test";
import type { Step } from "./schemas.ts";
import { checkProblem } from "./step_check.ts";
import { assertSound, workflowProblems } from "./validate.ts";

const step = (overrides: Partial<Step> & { key: string }): Step => ({
  title: overrides.key,
  kind: "command",
  requires: [],
  on_failure: "stop",
  evidence: [{ line: 1 }],
  ...overrides,
});
const SOURCE = { text: "webmaster check <site>\nmise run build" };
const INPUTS = [{ name: "site", description: "The site." }];

describe("workflowProblems", () => {
  it("accepts a sound workflow", () => {
    const steps = [
      step({ key: "check", run: "webmaster check {site}", needs: ["site"] }),
      step({ key: "build", run: "mise run build", requires: ["check"], check: "run: test -f dist/index.html" }),
    ];
    expect(workflowProblems(steps, INPUTS, SOURCE)).toEqual([]);
  });

  it("names every problem", () => {
    const steps = [
      step({ key: "a", run: "mise run build", requires: ["b"] }),
      step({ key: "a", kind: "judgment", run: "mise run build" }),
      step({ key: "c", run: "rm -rf /" }),
      step({ key: "d", evidence: [] }),
      step({ key: "e", kind: "command" }),
      step({ key: "f", run: "mise run build", check: "echo ok" }),
    ];
    expect(workflowProblems(steps, INPUTS, SOURCE)).toEqual([
      "step \"a\" requires \"b\", which is not an earlier step",
      "step key \"a\" is used twice",
      "step \"a\" is a judgment step and has a run",
      "step \"c\" runs \"rm -rf /\", which the source never does",
      "step \"d\" is a command with no run",
      "step \"d\" has no evidence",
      "step \"e\" is a command with no run",
      "step \"f\" check: a check is \"<preset>: <subject>\" with a preset from run, file_exists, file_absent, http_ok, grep, or empty for none; got \"echo ok\"",
    ]);
  });

  it("compares a command to the source modulo line continuations and spacing", () => {
    const source = { text: "scripts/deploy.sh 1 page.html \\\n        --target=prod   --confirm-prod" };
    const steps = [step({ key: "a", run: "scripts/deploy.sh 1 page.html --target=prod --confirm-prod" })];
    expect(workflowProblems(steps, [], source)).toEqual([]);
  });

  it("assertSound throws one error listing the problems", () => {
    expect(() => assertSound([step({ key: "x", run: "nope" })], [], SOURCE)).toThrow(
      "the derived workflow is not sound: step \"x\" runs \"nope\", which the source never does",
    );
  });
});

describe("checkProblem", () => {
  const inputs = new Set(["host"]);

  it("lets a gate with no command state its verdict, and nothing with a command", () => {
    expect(checkProblem("states: no violations remain", inputs, false)).toBeUndefined();
    expect(checkProblem("states: no violations remain", inputs, true)).toContain("needs a check that can run");
    expect(checkProblem("echo x", inputs, false)).toContain("states");
  });

  it.each([
    "",
    "run: test -f dist/index.html",
    "file_exists: dist/index.html",
    "http_ok: https://{host}/health",
    "grep: build/equivalence.json pattern=pass",
  ])("accepts %j", (check) => {
    expect(checkProblem(check, inputs, true)).toBeUndefined();
  });

  it.each([
    ["echo done", "preset"],
    ["run: echo done", "cannot fail"],
    ["run: true", "cannot fail"],
    ["http_ok: shop.example.com", "http_ok takes a URL"],
    ["grep: file.json", "grep takes"],
    ["file_exists: {nope}/x", "not one of the inputs"],
  ])("refuses %j", (check, why) => {
    expect(checkProblem(check, inputs, true)).toContain(why);
  });
});
