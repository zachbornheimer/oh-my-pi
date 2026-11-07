import { importTargets, relativeImports } from "./imports.js";
import { DECLARATION_ONLY_STEMS, type PlannedFile } from "./locate_checks.js";
import { extensionOf, stemOf } from "./paths.js";

/** Languages whose drafts these checks read. A draft in another language is checked only for being non-empty. */
const SCRIPT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LOOSE_TYPE = /(?::\s*any\b|<any[,>]|\bas\s+any\b|\bany\[\])/;
const DEFAULT_EXPORT = /^export\s+default\b/m;
const EXPORT_DECLARATION =
  /^export\s+(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
const TYPE_ONLY_DECLARATIONS = new Set(["interface", "type"]);
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const CONSTANT_LINE = /^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\b/;
const MAX_CONCEPTS_PER_MODULE = 1;

/** What a draft is checked against. */
export interface DraftScene {
  readonly file: PlannedFile;
  /** Every repo-relative path that exists. */
  readonly known: ReadonlySet<string>;
  /** Every path this change creates. */
  readonly changeSet: ReadonlySet<string>;
  /** Numbers the design mentions, which a module must name. */
  readonly numbers: readonly string[];
}

const withoutComments = (code: string): string => code.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");

function exportedConcepts(code: string): string[] {
  return [...code.matchAll(EXPORT_DECLARATION)]
    .filter(([, kind, name]) => !TYPE_ONLY_DECLARATIONS.has(kind!) && !CONSTANT_NAME.test(name!))
    .map(([, , name]) => name!);
}

function oneConceptProblem(path: string, code: string): string | undefined {
  const concepts = exportedConcepts(code);
  if (concepts.length <= MAX_CONCEPTS_PER_MODULE) return undefined;
  return `${path} exports ${concepts.length} concepts (${
    concepts.join(", ")
  }): a file does one thing, so move all but one to their own files`;
}

function magicNumberProblems(code: string, numbers: readonly string[]): string[] {
  const lines = code.split("\n").filter((line) => !CONSTANT_LINE.test(line));
  return numbers.filter((number) => lines.some((line) => new RegExp(`(?<![\\w.])${number}(?![\\w.])`).test(line))).map(
    (number) =>
      `the number ${number} is written outside a named constant: declare const NAME = ${number} and use the name`,
  );
}

function unresolvedImports(scene: DraftScene, code: string): string[] {
  const exists = (path: string): boolean => scene.known.has(path) || scene.changeSet.has(path);
  return relativeImports(code)
    .filter((specifier) => !importTargets(scene.file.path, specifier).some(exists))
    .map((specifier) => `the import "${specifier}" is not a file of the repo or of this change`);
}

/**
 * Why a drafted file breaks the repo's conventions, in the model's words; empty when it does not. Reads TypeScript and
 * JavaScript; any other language is only required to be non-empty.
 */
export function draftProblems(content: string, scene: DraftScene): string[] {
  if (content.trim() === "") return ["the file is empty"];
  if (!SCRIPT_EXTENSIONS.includes(extensionOf(scene.file.path))) return [];
  if (scene.file.role !== "module" && scene.file.role !== "test") return [];
  const code = withoutComments(content);
  const problems: (string | undefined)[] = [
    LOOSE_TYPE.test(code) ? "use a precise type: no `any`" : undefined,
    DEFAULT_EXPORT.test(code) ? "use named exports only: no `export default`" : undefined,
    ...unresolvedImports(scene, code),
  ];
  if (scene.file.role === "module") {
    if (!DECLARATION_ONLY_STEMS.includes(stemOf(scene.file.path))) {
      problems.push(oneConceptProblem(scene.file.path, code));
    }
    problems.push(...magicNumberProblems(code, scene.numbers));
  }
  return problems.filter((problem): problem is string => problem !== undefined);
}
