import {
  dataDirectoryFacts,
  documentFacts,
  headCommentFacts,
  packageScriptFacts,
  sourceFacts,
  taskFacts,
} from "./folder_facts.js";
import { type FolderWalk, walkFolder } from "./folder_walk.js";
import type { Machine } from "./machine.js";
import type { Source } from "./types.js";

/** Characters of the inventory each part may take; a part that is cut says so. */
const DOCUMENT_BUDGET = 8000;
const TASK_BUDGET = 4000;
const SCRIPT_BUDGET = 5000;
const SOURCE_BUDGET = 36000;
const DATA_BUDGET = 4000;
const PATH_BUDGET = 9000;

const MAX_DOCUMENTS = 40;
const MAX_SCRIPTS = 60;
const MAX_SOURCE_FILES = 400;
const MAX_DATA_FILES = 80;
const MAX_FILE_LINES = 2000;
const READ_BATCH = 32;

/** The documents whose opening prose says what the project is; the agent-instruction files only repeat boilerplate. */
const INTRO_DOCUMENT = /^(?:README|PRODUCT)[^/]*\.md$/i;
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs|go|py|rs|sh|rb|php|swift)$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|testdata|fixtures)\/|\.(?:test|spec)\.|_test\.|(?:^|\/)test_[^/]*\.py$/;
const DATA_FILE = /\.(?:ya?ml|json|toml)$/;
const DATA_PATH = /(?:^|\/)(?:rules|workflows|jobs|handlers|registry|checks)\//;
const TASK_FILE = /^(?:mise\.toml|Makefile|package\.json)$/;
/** A path whose directory or name says it holds something someone runs; these are read first when the budget is short. */
const LIKELY_CAPABILITY =
  /(?:^|\/)(?:jobs?|handlers?|commands?|cmd|cli|actions?|tasks?|checks?|gates?|probes?|rules?|detectors?|validators?|generators?|operations?|pipelines?)(?:\/|[-_.])/i;

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Reads `paths` a batch at a time and returns the text of each that could be read. */
async function readAll(
  root: string,
  paths: readonly string[],
  machine: Machine,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (let start = 0; start < paths.length; start += READ_BATCH) {
    signal?.throwIfAborted();
    const batch = paths.slice(start, start + READ_BATCH);
    const read = await Promise.all(batch.map((path) => machine.readTextFile(`${root}/${path}`)));
    batch.forEach((path, index) => {
      const text = read[index];
      if (text !== undefined) texts.set(path, text.split("\n").slice(0, MAX_FILE_LINES).join("\n"));
    });
  }
  return texts;
}

interface Section {
  readonly title: string;
  readonly lines: readonly string[];
  readonly budget: number;
}

/** A section as text, cut to its budget; `cut` is true when lines were left out. */
function render(section: Section): { text: string; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of section.lines) {
    used += line.length + 1;
    if (used > section.budget) break;
    kept.push(line);
  }
  const cut = kept.length < section.lines.length;
  const note = cut ? [`(${section.lines.length - kept.length} more lines left out)`] : [];
  return { text: [`# ${section.title}`, ...kept, ...note].join("\n"), cut };
}

/** Per-file code facts, the files that enumerate values or register verbs before those that only export names. */
function codeLines(paths: readonly string[], texts: Map<string, string>): string[] {
  const perFile = paths.map((path) => sourceFacts(path, texts.get(path) ?? "")).filter((lines) => lines.length > 0);
  return [...perFile.filter((lines) => lines.length > 1), ...perFile.filter((lines) => lines.length === 1)].flat();
}

function sectionsOf(walk: FolderWalk, picked: Picked, texts: Map<string, string>): Section[] {
  const facts = (paths: readonly string[], of: (path: string, text: string) => string[]) =>
    paths.flatMap((path) => of(path, texts.get(path) ?? ""));
  const { documents, tasks, scripts, sources, data } = picked;
  return [
    {
      title: "Documents (heading lines)",
      lines: facts(documents, (p, t) => documentFacts(p, t, INTRO_DOCUMENT.test(p))),
      budget: DOCUMENT_BUDGET,
    },
    {
      title: "Task runners",
      lines: facts(tasks, (p, t) => (nameOf(p) === "package.json" ? packageScriptFacts(p, t) : taskFacts(p, t))),
      budget: TASK_BUDGET,
    },
    { title: "Scripts (what each opens with)", lines: facts(scripts, headCommentFacts), budget: SCRIPT_BUDGET },
    {
      title: "Code (exported names, lists of values, CLI verbs)",
      lines: codeLines(sources, texts),
      budget: SOURCE_BUDGET,
    },
    { title: "Data files (rules, workflows, jobs)", lines: dataDirectoryFacts(data, texts), budget: DATA_BUDGET },
    { title: "Files", lines: walk.files.filter((path) => !TEST_PATH.test(path)), budget: PATH_BUDGET },
  ];
}

/** The files each part of the inventory reads. */
interface Picked {
  readonly documents: string[];
  readonly tasks: string[];
  readonly scripts: string[];
  readonly sources: string[];
  readonly data: string[];
}

/** The files each part of the inventory reads, within the limits above. */
export function classify(files: readonly string[]): Picked {
  const untested = files.filter((path) => !TEST_PATH.test(path));
  const code = untested.filter((path) => SOURCE_FILE.test(path) && !path.startsWith("scripts/"));
  return {
    documents: files.filter((path) => path.endsWith(".md") && (!path.includes("/") || path.startsWith("docs/"))).slice(
      0,
      MAX_DOCUMENTS,
    ),
    tasks: files.filter((path) => TASK_FILE.test(nameOf(path)) && path.split("/").length <= 2),
    scripts: untested.filter((path) => path.startsWith("scripts/")).slice(0, MAX_SCRIPTS),
    sources: [
      ...code.filter((path) => LIKELY_CAPABILITY.test(path)),
      ...code.filter((path) => !LIKELY_CAPABILITY.test(path)),
    ].slice(0, MAX_SOURCE_FILES),
    data: untested.filter((path) =>
      DATA_FILE.test(path) && (DATA_PATH.test(path) || path.startsWith(".github/workflows/"))
    )
      .slice(0, MAX_DATA_FILES),
  };
}

/** A folder as a source: a bounded inventory of what it documents, runs and exports, never the whole tree. */
export async function folderSource(ref: string, root: string, machine: Machine, signal?: AbortSignal): Promise<Source> {
  const walk = await walkFolder(root, machine, signal);
  const picked = classify(walk.files);
  const texts = await readAll(root, Object.values(picked).flat(), machine, signal);
  const rendered = sectionsOf(walk, picked, texts).map(render);
  return {
    ref,
    kind: "folder",
    body: [`Folder: ${root}`, ...rendered.map((section) => section.text)].join("\n"),
    anchors: walk.files,
    truncated: walk.truncated || rendered.some((section) => section.cut),
  };
}
