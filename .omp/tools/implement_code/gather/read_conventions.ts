import type { Conventions, Excerpt, Sibling } from "../conventions.js";
import { replacedNames } from "../design_text.js";
import type { Design, Hints } from "../schemas.js";
import type { HostMachine } from "../machine.js";
import { entriesOf, indexDirectories } from "./directories.js";
import { present, readExcerpt } from "./excerpts.js";
import { readGuidance } from "./guidance.js";
import { rankHomes } from "./home_ranking.js";
import { MAX_ENTRIES, MAX_FILE_CHARS, MAX_SIBLING_CHARS, MAX_TEST_CHARS } from "./limits.js";
import { findRegistries } from "./registries.js";
import { listRepoFiles } from "./repo_files.js";
import { chooseSiblings, type SiblingUnit } from "./sibling_units.js";
import { languageOf, namedExportsOnly, namesOfSiblings, namingOf, readConfigs, testLayoutOf } from "./style.js";
import { readSupportFiles } from "./support_files.js";
import { findUsages } from "./usages.js";

/** A sibling's files read in turn until the unit's character budget is spent. */
async function readSibling(
  machine: HostMachine,
  repo: string,
  unit: SiblingUnit,
  known: ReadonlySet<string>,
): Promise<Sibling> {
  const files: Excerpt[] = [];
  let remaining = MAX_SIBLING_CHARS;
  for (const path of unit.files) {
    if (remaining <= 0) break;
    const excerpt = await readExcerpt(machine, repo, path, Math.min(MAX_FILE_CHARS, remaining));
    if (excerpt === undefined) continue;
    files.push(excerpt);
    remaining -= excerpt.text.length;
  }
  const tests = (await Promise.all(unit.tests.map((path) => readExcerpt(machine, repo, path, MAX_TEST_CHARS)))).filter(
    present,
  );
  return { name: unit.name, files, tests, support: await readSupportFiles(machine, repo, tests, known) };
}

/**
 * Reads what the repo does, as data: its layout, the siblings closest to the design with their tests, the registries
 * that list modules, style signals, the conventions it writes down and where replaced names are still used. Only reads.
 */
export async function readConventions(
  machine: HostMachine,
  repo: string,
  design: Design,
  hints: Hints | undefined,
): Promise<Conventions> {
  const { paths, truncated } = await listRepoFiles(machine, repo);
  const index = indexDirectories(paths);
  const homes = rankHomes(index, design, hints?.near);
  const siblings = await Promise.all(
    chooseSiblings(index, homes, design, paths).map((unit) => readSibling(machine, repo, unit, new Set(paths))),
  );
  const home = homes[0] ?? "";
  const siblingSources = siblings.flatMap((sibling) => sibling.files.map((file) => file.path));
  const language = hints?.language
    ?? languageOf(siblingSources.length > 0 ? siblingSources : paths);
  const tests = siblings.flatMap((sibling) => sibling.tests.map((test) => test.path));
  const layout = testLayoutOf(tests, paths);
  const topLevel = entriesOf(index, "", MAX_ENTRIES);
  return {
    language,
    layout: {
      top_level: topLevel,
      home,
      home_entries: entriesOf(index, home, MAX_ENTRIES),
      near: homes.slice(1).map((directory) => ({ directory, entries: entriesOf(index, directory, MAX_ENTRIES) })),
      known_files: paths,
      truncated,
    },
    siblings,
    registries: await findRegistries(machine, repo, paths, homes),
    style: {
      test_layout: layout.layout,
      test_root: layout.root,
      naming: namingOf(namesOfSiblings(siblings)),
      named_exports_only: namedExportsOnly(language, siblings),
      config: await readConfigs(machine, repo, paths, home),
    },
    guidance: await readGuidance(machine, repo, paths, homes),
    usages: await findUsages(machine, repo, replacedNames(design)),
  };
}
