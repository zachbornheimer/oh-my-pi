/**
 * The model questions this tool asks, copied from the Mastra capability's question files: the reply field,
 * the instructions, the worked examples as the model is shown them (structured examples rendered as YAML), and the
 * JSON Schema of the reply value.
 */

export interface LanguageQuestion {
  readonly field: string;
  readonly instructions: string;
  readonly examples: readonly string[];
  readonly schema: Readonly<Record<string, unknown>>;
}

export const QUESTIONS = {
  "locate": {
    "Files": {
      "field": "Files",
      "instructions": "Decide which files implementing the design below must be created, and which existing registries must be edited, so the new code sits exactly where this codebase would put it. The brief shows the repo's layout, the closest existing siblings of the design (with the files and tests they own), its registries and its conventions: follow them. Match a sibling's directory depth, file names, naming style and which files it has (a schema file, a README, a questions directory only when the design has a model step), and keep tests where the siblings keep theirs.\nGive every file a repo-relative path written with \"/\", a role and a reason. role is \"module\" (code), \"test\" (a test of a module), \"registry\" (an existing file from the brief's list of editable files that must gain lines to list or call the new module: a registry that lists the siblings, or the file that should use the new code; it is edited by insertion only) or \"doc\" (a new README, only when the siblings have one). Edit only the files that name the siblings or call them: leave package manifests and task files alone. Create only what the siblings have and the design needs: no fixtures, no questions directory (a model step's question files) unless the design has such a step. Every module needs a test file. Do not reuse a path that exists. One concept per file: split a file that needs \"and\" to describe it. Prefer the registry pattern the repo already uses over a new switch or list in the caller. Names say what the thing is, never how it is done: no vendor, store or transport in a name, and no \"utils\", \"helpers\" or \"manager\". Put nothing outside the repo.",
      "examples": [
        "answer:\n    - path: src/leaf/trim_text/trim_text.ts\n      reason: the leaf, named like its sibling shout_text\n      role: module\n    - path: src/leaf/trim_text/schemas.ts\n      reason: the input and output shapes, as shout_text keeps them\n      role: module\n    - path: test/leaf/trim_text/trim_text.test.ts\n      reason: covers the leaf where the siblings' tests live\n      role: test\n    - path: src/leaf/index.ts\n      reason: the barrel that lists every leaf\n      role: registry\nprompt: |-\n    Design: a leaf `trim_text` that returns its input without surrounding blanks.\n    Siblings: src/leaf/shout_text/ (shout_text.ts, schemas.ts), tests in test/leaf/shout_text/shout_text.test.ts.\n    Registries: src/leaf/index.ts\n    Tests live in a separate tree: test/"
      ],
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "role": {
              "type": "string",
              "enum": [
                "module",
                "test",
                "registry",
                "doc"
              ]
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "path",
            "role",
            "reason"
          ],
          "additionalProperties": false
        }
      }
    }
  },
  "draft": {
    "Source": {
      "field": "Source",
      "instructions": "Write the complete contents of the one file named under \"The file\", so it does the design's part of the work and nothing else. The brief gives the design, every file of this change (so you can import them by their real paths), the repo's conventions and example files from the closest siblings. Write the file the way those siblings are written: the same structure, naming, error style, test style and comment density. Follow the siblings over your own habits.\nRules: the file does one thing; name every number and string the design mentions as a constant; use precise types, never \"any\"; export by name, never by default; import only paths that exist in the repo or are files of this change, written the way the siblings write them; no TODOs and no placeholder bodies; a test file asserts behavior with fixtures, not implementation, and stays short: the design's main behaviors and its failure paths in at most six cases, no helper types or large tables. Use every helper, fixture and import exactly as the example files use it: read how an example calls a helper and uses what it returns before you write the same call, and never assume a helper's signature or return shape that no example shows. Reply with the file's text only: no explanation, and no markdown fence unless the file itself is markdown.",
      "examples": [],
      "schema": {
        "type": "string"
      }
    }
  },
  "registry_edit": {
    "Insertions": {
      "field": "Insertions",
      "instructions": "The registry file under \"The registry\" lists modules by name. Add the new modules of this change to it, the way the existing entries are written, in the position the file's own order suggests (alphabetical when it is alphabetical). Edit by insertion only: never change or remove an existing line. Each insertion has \"after\", one existing line of the file copied exactly (it must match exactly one line), and \"lines\", the new lines to put right after it, with the same indentation as their neighbours. One insertion per place that needs a line: an import and a list entry are two insertions.",
      "examples": [
        "answer:\n    - after: import { shout_text } from \"./shout_text/shout_text.js\";\n      lines:\n          - import { trim_text } from \"./trim_text/trim_text.js\";\n    - after: \"  shout_text,\"\n      lines:\n          - \"  trim_text,\"\nprompt: |-\n    The registry (src/leaf/index.ts):\n    import { shout_text } from \"./shout_text/shout_text.js\";\n\n    export const leaves = [\n      shout_text,\n    ];\n    The new modules: src/leaf/trim_text/trim_text.ts exports trim_text"
      ],
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "after": {
              "type": "string"
            },
            "lines": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "minItems": 1
            }
          },
          "required": [
            "after",
            "lines"
          ],
          "additionalProperties": false
        }
      }
    }
  },
  "review": {
    "Findings": {
      "field": "Findings",
      "instructions": "Review the drafted change under \"The change\" against the design, the repo's conventions and SRP, DRY and SOLID, as a strict maintainer of this codebase would. Report only real problems: a file that does more than one thing, logic copied from a sibling instead of reused, an interface that leaks how instead of what, a name that says how, a registry edit or a touchpoint that is missing or that a sibling would have written differently, a magic value, a test that checks nothing. Each finding names the principle, the file it is about (empty for the whole change), what is wrong and how to fix it, and your confidence from 0 to 1 that it is real and worth fixing. Give an empty list when the change is clean; do not pad.",
      "examples": [],
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "principle": {
              "type": "string"
            },
            "file": {
              "type": "string"
            },
            "finding": {
              "type": "string"
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          },
          "required": [
            "principle",
            "file",
            "finding",
            "confidence"
          ],
          "additionalProperties": false
        }
      }
    }
  }
} as unknown as Readonly<
  Record<"locate" | "draft" | "registry_edit" | "review", Readonly<Record<string, LanguageQuestion>>>
>;
