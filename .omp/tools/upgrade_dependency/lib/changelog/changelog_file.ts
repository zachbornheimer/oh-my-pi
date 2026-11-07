import type { Entry } from "../schemas.js";
import type { Assembly } from "./assemble.js";
import { entriesFromBody } from "./parse.js";
import type { Repo } from "./ports.js";
import { ERR_NOT_FOUND, releasesTrackPackage, repoUrl } from "./ports.js";

// Port of agentmux internal/changelog/changelog_file.go: a repository's CHANGELOG.md, read at most once
// and only when some version has no GitHub release.

const CHANGELOG_FILE_NAME = "CHANGELOG.md";
const DEFAULT_BRANCH_REF = "";
const DEFAULT_BRANCH_NAME = "HEAD";

// versionHeading matches a markdown heading that names a version, such as "## 7.1.1", "## [0.21.4] - 2026-01-01", or "### v1.2.3 (2020-01-01)".
const VERSION_HEADING = /^#{1,3}\s+.*?\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** changelogSections splits a CHANGELOG.md into the body under each version heading, keyed by version. The first section for a version wins. */
export function changelogSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = "";
  let body: string[] = [];
  const flush = () => {
    if (current === "") return;
    if (!sections.has(current)) sections.set(current, body.join("\n"));
  };
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const m = VERSION_HEADING.exec(line);
    if (m !== null) {
      flush();
      current = m[1]!;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/** changelogFile is a repository's CHANGELOG.md, read at most once and only when some version has no GitHub release. */
export class ChangelogFile {
  loaded = false;
  sections?: Map<string, string>;
  source = "";
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** changelogRefs lists where the To version's CHANGELOG may be read, best guess first: its release tag, common tag spellings, then the default branch. */
export function changelogRefs(a: Assembly): string[] {
  const refs: string[] = [];
  const release = a.releases.get(a.r.to);
  if (release !== undefined) refs.push(release.tag);
  refs.push(a.r.to, "v" + a.r.to, a.r.package + "@" + a.r.to, DEFAULT_BRANCH_REF);
  return unique(refs);
}

/** changelogPaths lists where the package's CHANGELOG may live: its own folder in a monorepo, and the repository root when the repo's releases are its own. */
export function changelogPaths(a: Assembly): string[] {
  const paths: string[] = [];
  if (a.repo.directory !== "") {
    const directory = a.repo.directory.endsWith("/") ? a.repo.directory : a.repo.directory + "/";
    paths.push(directory + CHANGELOG_FILE_NAME);
  }
  if (releasesTrackPackage(a.repo)) paths.push(CHANGELOG_FILE_NAME);
  return paths;
}

function blobUrl(repo: Repo, ref: string, file: string): string {
  const resolved = ref === DEFAULT_BRANCH_REF ? DEFAULT_BRANCH_NAME : ref;
  return `${repoUrl(repo)}/blob/${resolved}/${file}`;
}

async function load(file: ChangelogFile, a: Assembly): Promise<void> {
  file.loaded = true;
  if (!a.hasRepo) return;
  for (const ref of changelogRefs(a)) {
    for (const path of changelogPaths(a)) {
      let text: string;
      try {
        text = await a.ports.releases.file(a.repo, ref, path);
      } catch (error) {
        if (error === ERR_NOT_FOUND) continue;
        a.gap(`could not read ${path}: ${(error as Error).message}`);
        return;
      }
      const sections = changelogSections(text);
      if (sections.size > 0) {
        file.sections = sections;
        file.source = blobUrl(a.repo, ref, path);
        return;
      }
    }
  }
}

/** entriesFor returns the entries of one version's section, and the web address of the file they came from. */
export async function entriesFor(
  file: ChangelogFile,
  a: Assembly,
  version: string,
): Promise<{ entries: Entry[]; source: string }> {
  if (!file.loaded) await load(file, a);
  const body = file.sections?.get(version);
  if (body === undefined) return { entries: [], source: "" };
  return { entries: entriesFromBody(version, file.source, body), source: file.source };
}
