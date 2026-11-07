/**
 * The six prompts of upgrade_dependency, copied verbatim from the Mastra capability's questions/*.yaml, with the JSON
 * Schema each reply must match and the code that joins a prompt, its input and its schema into the text one model
 * call reads (what Mastra's `languageRequest` and `promptForDecoder` build).
 */

/** What introduces the reply schema at the end of every prompt. */
export const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

export interface LanguageQuestion {
  readonly field: string;
  readonly instructions: string;
  readonly examples: readonly string[];
  /** JSON Schema of the reply itself (not wrapped under the question field). */
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface KindQuestion {
  readonly field: string;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** qualifies.yaml: a closed choice. Mastra asked a calibrated decision model; here it is a JSON reply checked in code. */
export const QUALIFIES: KindQuestion = {
    "field": "Kind",
    "instructions": "Read the pull request title, its description, the paths it changes and the diffs shown, and say what kind of change it is. Judge it by the changed files, not by the description: a description may preview or promise upgrades that later pull requests will make (a \"What to Expect\" or \"Detected dependencies\" section), and those are not changes in this one. A version move anywhere counts: wherever a version is pinned — a package manifest or a lockfile, a `uses:` pin in a `.github/workflows/*.yml` (a sha with the version in a trailing `# vX.Y.Z` comment counts), a `FROM` pin in a Dockerfile or Containerfile, a toolchain pin (`mise.toml`, `.tool-versions`, `.nvmrc`, `global.json`, `.python-version`), and their like — a changed line that replaces one version with another makes the pull request an upgrade, whatever opened it.",
    "criteria": {
      "upgrade": "At least one changed line in any file replaces one version of something with another, wherever that version is pinned: a package manifest or lockfile, a `uses:` pin in a GitHub Actions workflow, a Dockerfile or Containerfile `FROM`, a toolchain pin, and their like — whatever opened the pull request.",
      "config_only": "The pull request only adds or edits the configuration of a dependency bot (renovate.json, .github/renovate.json5, .github/dependabot.yml and the like), such as Renovate's \"Configure Renovate\" onboarding pull request. No version moves anywhere in the changed files.",
      "not_dependency": "Neither: it changes code, docs or other files, and no changed line moves a version of anything, wherever that version would be pinned."
    }
  };

/** changes.yaml */
export const CHANGES: LanguageQuestion = {
    "field": "Packages",
    "instructions": "Read the changed files and the pull request description and say which dependencies this pull request is for: the ones it requests, the way its own table or a changed manifest range names them. Everything else the resolver moved with them is collateral, not another dependency to upgrade: a package's platform-specific or per-architecture binaries, its transitive dependencies, and the packages that only follow one of those. Name that collateral in the evidence of the dependency it belongs to, not as a dependency of its own. For each dependency the pull request is for, give its name, the version it moves from, the version it moves to, and the evidence you read it from: the changed file and the line, quoting the two lines that show the old and the new version. Take both versions from the lines this pull request changes, wherever the version is pinned — a package manifest, a lockfile, a `uses:` pin in a GitHub Actions workflow (a sha with the version in a trailing comment), a Dockerfile `FROM`, a toolchain pin, and their like: the removed line is the version it moves from and the added line is the version it moves to. The description is a claim and the diff is the change, so when the two disagree the diff wins. The description may list pull requests that will be opened LATER (a \"What to Expect\", \"Detected dependencies\" or pending-branches section). Those are other pull requests: never name a package or take a version from that preview. Never write \"unknown\", \"not visible\" or any other placeholder as a version. A package whose old and new version you cannot both read from a changed line is not one this pull request upgrades, so leave it out. When a changed range already allowed the new version, name the lockfile line that moved and say so in the evidence.",
    "examples": [
      "answer:\n    packages:\n        - evidence: The pull request is for esbuild 0.28.1 → 0.28.2. pnpm-lock.yaml moves the importer's version line under an unchanged specifier `^0.28.1`, and `-  esbuild@0.28.1:` becomes `+  esbuild@0.28.2:`. The twenty-five `@esbuild/*` platform entries and acorn move with it as collateral of this one bump, not as dependencies of their own.\n          from: 0.28.1\n          name: esbuild\n          to: 0.28.2"
    ],
    "schema": {
      "type": "object",
      "properties": {
        "packages": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1
              },
              "from": {
                "type": "string",
                "minLength": 1
              },
              "to": {
                "type": "string",
                "minLength": 1
              },
              "evidence": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "name",
              "from",
              "to",
              "evidence"
            ]
          }
        }
      },
      "required": [
        "packages"
      ]
    }
  };

/** changelog.yaml */
export const CHANGELOG: LanguageQuestion = {
    "field": "Entries",
    "instructions": "For each package being upgraded, establish what changed in the range being crossed and what each change means to a program that uses the package. Research the package's own published record: its release notes, its repository's CHANGELOG.md, the advisory database, and the release notes already pasted into this pull request. Ground every entry in a reference you actually read and return that reference's URL on the entry. Read the meaning, not the title: say what the change does to a program that uses this package. List every published security advisory that affects a version inside the range, with the versions it affected. Never infer a change from a version number, never invent a version, a note or an advisory, and never report an entry you could not ground — when the record for a range cannot be read, say so and return what you could ground.",
    "examples": [
      "answer:\n    packages:\n        - advisories: []\n          entries:\n              - kind: behavior\n                text: \"Tree-shaking no longer drops an import used through a TypeScript import alias, and CSS minification keeps a nested `&`. The overwrite guard is restored: an input file is no longer replaced unless --allow-overwrite is passed.\"\n                url: https://github.com/evanw/esbuild/releases/tag/v0.28.2\n                version: 0.28.2\n              - kind: fix\n                text: Lowered logical assignment operators (`||=`) are no longer minified incorrectly, and a duplicate target engine now resolves to the lowest version.\n                url: https://github.com/evanw/esbuild/releases/tag/v0.28.2\n                version: 0.28.2\n          name: esbuild"
    ],
    "schema": {
      "type": "object",
      "properties": {
        "packages": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1
              },
              "entries": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "version": {
                      "type": "string",
                      "minLength": 1
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "breaking",
                        "deprecation",
                        "security",
                        "behavior",
                        "fix",
                        "other"
                      ]
                    },
                    "url": {
                      "type": "string",
                      "minLength": 1
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "version",
                    "kind",
                    "url",
                    "text"
                  ]
                }
              },
              "advisories": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string"
                    },
                    "url": {
                      "type": "string",
                      "minLength": 1
                    },
                    "affects": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "summary": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "url",
                    "affects",
                    "summary"
                  ]
                }
              }
            },
            "required": [
              "name",
              "entries",
              "advisories"
            ]
          }
        }
      },
      "required": [
        "packages"
      ]
    }
  };

/** usage.yaml */
export const USAGE: LanguageQuestion = {
    "field": "Usages",
    "instructions": "Say how this application reaches each package being upgraded, by tracing it the way the tools that own this question trace it — not by searching for the name. Follow every import from the entry points to what it reaches, the way knip builds its graph; a file no entry reaches is not a usage. Separate declared from reached the way depcheck does: a manifest or lockfile entry is a declaration, not a call. Follow calls, not only imports, the way govulncheck and unladen build a call graph into the dependency — name the symbol that is called. When an advisory falls inside the range, say whether the code actually reaches the affected symbol, the way osv-scanner annotates a finding as called or uncalled. Then add the two forms those tools cannot see: an invocation of the package's command-line binary (the exact command line and the file that runs it, in any language) and a wrapper that depends on it (name the wrapper). For each usage, say how you established it, and whether anything in the changelog touches it, naming the entry by version. Never report a usage you could not establish, and never report an absence you did not trace.",
    "examples": [
      "answer:\n    usages:\n        - basis: read\n          evidence: \"ESBUILD_PATH = '/nq/node_modules/.bin/esbuild', then Open3.capture3(esbuild_path, '--minify', stdin_data: js_source)\"\n          file: lib/widget_renderer.rb\n          how: binary\n          line: 11\n          package: esbuild\n          touched: 0.28.2 — the restored overwrite guard and the CSS and logical-assignment minifier fixes reach this call\n        - basis: lockfile-trace\n          evidence: declared as ^0.28.1; no entry file reaches an import of it, so this is a declaration, not a call\n          file: package.json\n          how: direct-import\n          line: 43\n          package: esbuild\n          touched: \"\""
    ],
    "schema": {
      "type": "object",
      "properties": {
        "usages": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "package": {
                "type": "string",
                "minLength": 1
              },
              "file": {
                "type": "string",
                "minLength": 1
              },
              "line": {
                "type": "integer"
              },
              "how": {
                "type": "string",
                "enum": [
                  "direct-import",
                  "binary",
                  "wrapper"
                ]
              },
              "basis": {
                "type": "string",
                "enum": [
                  "import-graph",
                  "call-graph",
                  "lockfile-trace",
                  "advisory-trace",
                  "read"
                ]
              },
              "symbol": {
                "type": "string"
              },
              "evidence": {
                "type": "string",
                "minLength": 1
              },
              "touched": {
                "type": "string"
              }
            },
            "required": [
              "package",
              "file",
              "how",
              "basis",
              "evidence",
              "touched"
            ]
          }
        }
      },
      "required": [
        "usages"
      ]
    }
  };

/** facade.yaml */
export const FACADE: LanguageQuestion = {
    "field": "Plan",
    "instructions": "Decide whether this upgrade needs a facade, using the checklist: one or two call sites, or a dev-only tool, means a facade is optional; widespread use, or any system boundary — a process, an HTTP client, a store, an external SDK — means one is required, and it is built in this change rather than as a follow-up. When one is required, return the plan and nothing applied: the facade's name (what it does, not how — `Minify`, not `EsbuildMinify`), the one file it lives in, the boundary it owns, and the ordered steps that keep the suite green: tests that characterize the current behavior first, then the facade absorbing every call site, then the upgrade, running the suite after each step. For each step give the check that proves it, and say which steps need a human. When one is not required, say why in one sentence and return no steps. Never weaken a test to make a step pass, and never propose applying the upgrade before the characterization tests pass.",
    "examples": [
      "answer:\n    name: Minify\n    needed: true\n    owns: the esbuild binary invocation and its options\n    path: lib/minify.rb\n    reason: \"Three call sites reach esbuild by spawning its binary from Ruby, one of them the production widget renderer: a process boundary with no single owner.\"\n    steps:\n        - green_when: the characterization test passes against today's esbuild\n          human: false\n          order: 1\n          what: characterize the current minification output in a test that pins the bytes\n        - green_when: the suite passes with no behavior change\n          human: false\n          order: 2\n          what: route widget_renderer.rb, validate_esbuild.rb and benchmark_compression.rb through Minify\n        - green_when: mise run ci is green\n          human: true\n          order: 3\n          what: bump esbuild and re-run the suite, fixing only inside Minify if the invocation moved"
    ],
    "schema": {
      "type": "object",
      "properties": {
        "needed": {
          "type": "boolean"
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "owns": {
          "type": "string"
        },
        "steps": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "order": {
                "type": "integer"
              },
              "what": {
                "type": "string",
                "minLength": 1
              },
              "green_when": {
                "type": "string",
                "minLength": 1
              },
              "human": {
                "type": "boolean"
              }
            },
            "required": [
              "order",
              "what",
              "green_when"
            ]
          }
        }
      },
      "required": [
        "needed",
        "reason"
      ]
    }
  };

/** pr_body.yaml */
export const PR_BODY: LanguageQuestion = {
    "field": "Units",
    "instructions": "Write the part of a pull request description that only prose can: what the changelog entries mean for this codebase. For each package, in the order given, return its heading exactly as given and two to five sentences on the behavior changes that affect the files that reach it, naming the symbols or files an entry touches. Say plainly when nothing in the changelog affects this codebase. Say what the upgrade work changed about the call sites, including a facade that absorbed them, and what was left alone. Do not list the versions, the changelog entries, the files or the advisories; they are added from the facts around this prose.",
    "examples": [
      "answer:\n    units:\n        - behavior: \"Nothing in this range changes the output this codebase depends on: the widget renderer calls the CLI with --minify and reads stdout, and the restored overwrite guard only affects an in-place output path we never use. The minifier fixes for nested CSS `&` and for lowered `||=` do reach us, because frontend CSS and bundled JS pass through that same call.\"\n          heading: esbuild 0.28.1 → 0.28.2"
    ],
    "schema": {
      "type": "object",
      "properties": {
        "units": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "heading": {
                "type": "string",
                "minLength": 1
              },
              "behavior": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "heading",
              "behavior"
            ]
          }
        }
      },
      "required": [
        "units"
      ]
    }
  };

/** The prompt of one language question: instructions, examples, the input, then the reply schema (the reply itself, not wrapped under the field). */
export function languagePrompt(question: LanguageQuestion, input: string, note = ""): string {
  const examples = question.examples.map((example) => `Example:\n${example}\n`).join("");
  const tail = note === "" ? "" : `\n${note}\n`;
  return `## ${question.field}\n${question.instructions}\n${examples}${tail}\nPrompt:\n${input}\n${SCHEMA_LEAD}${JSON.stringify(question.schema)}`;
}

/** What the two researching steps are told about the tools they have: read-only ones, on a checkout of the head. */
export const CHANGELOG_TOOLS_NOTE =
  "Your working directory is a read-only checkout of the pull request head. You may call the read, grep, find and web_search tools; `read` also fetches a URL. Use web_search and `read` of URLs to ground the changelog entries, and cite what you read. Never write or change anything.";
export const USAGE_TOOLS_NOTE =
  "Your working directory is a read-only checkout of the pull request head. You may call the read, grep, find and web_search tools to trace the callers in it. Never write or change anything.";

/** The prompt of the qualifies question: the criteria of each kind, the pull request, and the closed reply. */
export function qualifiesPrompt(question: KindQuestion, state: unknown): string {
  const kinds = Object.keys(question.criteria);
  const criteria = kinds.map((kind) => `- ${kind}: ${question.criteria[kind]}`).join("\n");
  const reply = `{"${question.field}": ${kinds.map((kind) => `"${kind}"`).join(" | ")}}`;
  return `## ${question.field}\n${question.instructions}\n\nChoose exactly one:\n${criteria}\n\nPrompt:\n${JSON.stringify(state, null, 2)}\n\nRespond with only a JSON object of this shape, choosing one value: ${reply}`;
}
