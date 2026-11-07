/**
 * The objective-writing question, verbatim from the Mastra capability's questions/define_objective.yaml (the
 * instructions, the reply schema and the worked example), so the model is asked what Mastra asked.
 */

export const OBJECTIVE_INSTRUCTIONS = `Shape the goal under "The goal" into one atask objective for the project named below: one independently verifiable outcome, with a proof that checks that outcome and a regression that checks nothing it touches broke. The brief lists the project's real files, mise tasks, test runners, the test files near the goal (with the test names found in them), the files the work changes and the tasks already filed: those are the only files, tasks and test names you may name. Give the objective a title, an outcome, acceptance lines, a proof, a regression, a regression size and a rationale.
title: an imperative sentence of at most 80 characters that names the outcome ("Rank local models last when TypeSafe answers"), not the activity. Do not start it with "The", "A" or "To".
outcome: one sentence saying what is true when the goal is met.
acceptance: one to five plain statements, each of which a check could confirm. Say what is observable, not how it is built.
proof: one check that fails now and passes only once the goal is met. It runs the specific work, never a suite: one test file, one package, or one named test, and it finishes in 30 seconds. Write it as "<preset>: <subject> [key=value]" or "run: <shell command>", without size=. Aim it by the runner the brief lists. For Go, "go_test: ./internal/pkg name=TestThing" with a package that holds a test file in the brief; give name=REGEX only from a test name listed in the brief, else name the package's test file's tests by a word they share. For vitest or jest, "run: cd <runner dir> && <runner command> <test file path relative to that dir>". For pytest, "py_test: tests/test_x.py name=SUBSTRING". A mise test task listed as near the goal is the project's own test for that area: prefer it, "run: mise run test:<name>". Otherwise for a shell test, "run: bash tests/x.test.sh". Run a test from the directory its runner's config is in (the brief says where: "cd <dir> &&" for a Go module or a vitest config below the project root); the go_test preset runs at the project root only. When no test can show the goal but a file, a text in a file, or a service can, use "file_exists: path", "grep: path pattern=TEXT" or "http_ok: URL". A proof that runs a whole suite ("ci:", "mise run test", "mise run ci", "go test ./...", a runner given no file, "npm test") is refused, never resized. The presets are build, ci, file_absent, file_blake3, file_exists, go_test, grep, http_ok, js_test, lint, php_test, pl_test, playwright_run, pr_merged, py_test, rb_test, rs_test, run, sh_test and swift_test. A command that always succeeds (echo, true, exit 0) proves nothing and is refused.
regression: a different check that covers the smallest set of tests touching what the work changes: the tests of the package, directory or area the work lives in, plus the test files near the goal that exercise it. For Go, "go_test: ./internal/pkg" (no name) for the proof's package; for vitest or jest, the proof's directory and the related test files after "cd <dir> &&"; for pytest, the test files of the same area; or a "test:<area>" mise task. Run the whole suite ("mise run test", "mise run ci", "go test ./...", a runner given no file) only when the brief says the work is cross-cutting, or when nothing narrower in the brief covers it. The bare lint preset ("lint:") is never a regression. It must differ from the proof.
regression_size: how long the regression may take: "small" (up to 30 seconds), "medium" (up to 5 minutes) or "large" (up to 15 minutes). Use "large" only for a whole-suite regression, which must be large; a regression that names tests is small or medium. Never write size= inside a check.
draft: true only when the brief gives nothing to aim a proof at: no test file near the goal, no mise test task, and no file, text or service that the goal changes. A proof may name a test file that exists but does not yet hold the test: when a test file near the goal covers the goal's area, the proof runs that file (the work adds or changes the test in it). When a draft is right, proof and regression are "" and draft_reason is one sentence saying what is missing. Never use the whole suite or CI to make an ungrounded goal look provable. Otherwise draft is false and draft_reason is "".
rationale: one sentence on why this proof shows the goal is met.
Write only this goal's objective. The other goals alongside are separate; do not fold their work into this one. The open tasks already filed are done elsewhere. Use only paths, hosts, packages and test names that the brief or the user's words give you; do not invent names.`;

/** The JSON Schema of the objective itself; the reply wraps it as `{"ObjectiveSpec": ...}`. */
export const OBJECTIVE_SCHEMA = {
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "outcome": {
      "type": "string",
      "minLength": 1
    },
    "acceptance": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1,
      "maxItems": 5
    },
    "draft": {
      "type": "boolean"
    },
    "draft_reason": {
      "type": "string"
    },
    "proof": {
      "type": "string"
    },
    "regression": {
      "type": "string"
    },
    "regression_size": {
      "type": "string",
      "enum": [
        "small",
        "medium",
        "large"
      ]
    },
    "rationale": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "title",
    "outcome",
    "acceptance",
    "draft",
    "draft_reason",
    "proof",
    "regression",
    "regression_size",
    "rationale"
  ],
  "additionalProperties": false
} as const;

/** The worked example, as the YAML text Mastra shows a model. */
export const OBJECTIVE_EXAMPLE = `answer:
    acceptance:
        - With TypeSafe answering, ollama/nimble is ranked after every API model.
        - Without TypeSafe, the order of the candidates is unchanged.
    draft: false
    draft_reason: ""
    outcome: select_model ranks ollama/nimble after every API model whenever TypeSafe answers.
    proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast"
    rationale: The named test ranks a mixed candidate list and fails while nimble is not last.
    regression: "go_test: ./internal/capability"
    regression_size: medium
    title: Rank local models last when TypeSafe answers
prompt: |-
    Project: agentmux
    Project home: /home/zach/Developer/Personal/agentmux
    Project goal: Delegates work to coding agents.
    Project files (a trailing / marks a directory; … marks a listing that is cut short):
    go.mod
    internal/ …
    mise.toml
    Mise tasks: ci, lint, test
    Open tasks already filed: none
    Mise test tasks near the goal: none
    Test runners:
    - go in the project root (module github.com/zachbornheimer/agentmux): go test
    Test files near the goal (3 of 1486 listed):
    internal/capability/ranked_models_test.go [tests: TestRankedModelsPutLocalLast, TestRankedModelsKeepOrder]
    internal/capabilities/select_model_test.go
    delegate_select_model_test.go
    Changed files: none given
    Cross-cutting: no
    The goal: select_model ranks ollama/nimble last when TypeSafe answers
    Other goals alongside: none`;
