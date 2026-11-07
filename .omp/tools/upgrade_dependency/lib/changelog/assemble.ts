import type { Changelog, Range } from "../schemas.js";
import { ChangelogFile, entriesFor } from "./changelog_file.js";
import { entriesFromBody, entriesFromNotes } from "./parse.js";
import type { ChangelogPorts, Release, Repo } from "./ports.js";
import { ERR_UNSUPPORTED, releasesTrackPackage, repoUrl, validatePorts } from "./ports.js";
import { compareVersions, contains, isPrerelease, tagVersion, validateRange } from "./range.js";

// Port of agentmux internal/changelog/assemble.go: for each version in a range, the best available change
// notes, with a gap recorded for every fallback or miss. It fails only when the range or the ports are
// unusable; a source that cannot be reached becomes a gap, never an error.

const GAP_REPO_UNRESOLVED = (pkg: string, err: string) => `could not resolve the source repository for ${pkg}: ${err}`;
const GAP_VERSIONS_UNAVAILABLE = (pkg: string, err: string) =>
  `could not list the published versions of ${pkg}: ${err}`;
const GAP_RELEASES_UNAVAILABLE = (err: string) => `could not list GitHub releases: ${err}`;
const GAP_USED_CHANGELOG = (version: string) => `no GitHub release for ${version}; used CHANGELOG.md`;
const GAP_USED_NOTES = (version: string) =>
  `no GitHub release or CHANGELOG.md entry for ${version}; used Renovate PR notes`;
const GAP_NOTHING_COVERS = (version: string) =>
  `no GitHub release or CHANGELOG.md entry for ${version}; no Renovate PR notes`;
const GAP_ADVISORIES = (err: string) => `advisories unavailable: ${err}`;

/** The state one Assemble builds up (assemble.go assembly). */
export interface Assembly {
  r: Range;
  ports: ChangelogPorts;
  notes: string[];
  cl: Changelog;
  repo: Repo;
  hasRepo: boolean;
  releases: Map<string, Release>;
  file: ChangelogFile;
  notesUsed: boolean;
  gap(message: string): void;
}

class Gathering implements Assembly {
  readonly releases = new Map<string, Release>();
  readonly file = new ChangelogFile();
  repo: Repo = { owner: "", name: "", directory: "" };
  hasRepo = false;
  notesUsed = false;
  readonly cl: Changelog;

  constructor(
    readonly r: Range,
    readonly ports: ChangelogPorts,
    readonly notes: string[],
  ) {
    this.cl = { range: r, entries: [], advisories: [], sources: [], gaps: [] };
  }

  gap(message: string): void {
    this.cl.gaps.push(message);
  }

  addSource(url: string): void {
    if (url !== "" && !this.cl.sources.includes(url)) this.cl.sources.push(url);
  }

  async resolveRepo(): Promise<void> {
    let repo: Repo;
    try {
      repo = await this.ports.registry.source(this.r.ecosystem, this.r.package);
    } catch (error) {
      this.gap(GAP_REPO_UNRESOLVED(this.r.package, (error as Error).message));
      return;
    }
    this.repo = repo;
    this.hasRepo = true;
  }

  async loadReleases(): Promise<void> {
    if (!this.hasRepo) return;
    let list: Release[];
    try {
      list = await this.ports.releases.list(this.repo);
    } catch (error) {
      this.gap(GAP_RELEASES_UNAVAILABLE((error as Error).message));
      return;
    }
    const tracks = releasesTrackPackage(this.repo);
    for (const release of list) {
      const version = tagVersion(release.tag, this.r.package, tracks);
      if (version === undefined || !this.wanted(version)) continue;
      if (!this.releases.has(version)) this.releases.set(version, release);
    }
  }

  /** wanted says whether v is a version the upgrade passes through. Prereleases count only when the upgrade itself lands on one. */
  wanted(version: string): boolean {
    return contains(this.r, version) && (!isPrerelease(version) || isPrerelease(this.r.to));
  }

  /** versionsInRange lists, newest first, every version the upgrade passes through: the published ones, the ones with releases, and To itself. */
  async versionsInRange(): Promise<string[]> {
    const set = new Set<string>([this.r.to]);
    try {
      const published = await this.ports.registry.versions(this.r.ecosystem, this.r.package);
      for (const version of published) {
        if (this.wanted(version)) set.add(version);
      }
    } catch (error) {
      if (error !== ERR_UNSUPPORTED) this.gap(GAP_VERSIONS_UNAVAILABLE(this.r.package, (error as Error).message));
    }
    for (const version of this.releases.keys()) set.add(version);
    return [...set].sort((x, y) => compareVersions(y, x));
  }

  /** collect adds the best available notes for one version. */
  async collect(version: string): Promise<void> {
    const release = this.releases.get(version);
    if (release !== undefined) {
      const source = releaseUrl(this.repo, release);
      const entries = entriesFromBody(version, source, release.body);
      if (entries.length > 0) {
        this.add(source, entries);
        return;
      }
    }
    const { entries, source } = await entriesFor(this.file, this, version);
    if (entries.length > 0) {
      this.add(source, entries);
      this.gap(GAP_USED_CHANGELOG(version));
      return;
    }
    this.useNotes(version);
  }

  add(source: string, entries: Changelog["entries"]): void {
    this.cl.entries.push(...entries);
    this.addSource(source);
  }

  /** useNotes falls back to the pasted notes, which describe the whole range, so they attach once, to the newest version nothing else covered. */
  useNotes(version: string): void {
    const entries = entriesFromNotes(version, this.notes);
    if (entries.length === 0) {
      this.gap(GAP_NOTHING_COVERS(version));
      return;
    }
    this.gap(GAP_USED_NOTES(version));
    if (!this.notesUsed) {
      this.notesUsed = true;
      this.cl.entries.push(...entries);
    }
  }

  async addAdvisories(): Promise<void> {
    let found;
    try {
      found = await this.ports.advisories.for(this.r);
    } catch (error) {
      this.gap(GAP_ADVISORIES((error as Error).message));
      return;
    }
    this.cl.advisories.push(...found);
  }
}

function releaseUrl(repo: Repo, release: Release): string {
  if (release.url !== "") return release.url;
  return `${repoUrl(repo)}/releases/tag/${release.tag}`;
}

/**
 * Assemble gathers the change notes for every version in r. For each version it prefers the GitHub
 * release, then the repository's CHANGELOG.md, then the notes pasted into the upgrade PR, and records a
 * gap for every fallback or miss. It throws only when r or the ports are unusable.
 */
export async function Assemble(r: Range, ports: ChangelogPorts, fallbackNotes: string[]): Promise<Changelog> {
  validateRange(r);
  validatePorts(ports);
  const a = new Gathering(r, ports, fallbackNotes);
  await a.resolveRepo();
  await a.loadReleases();
  for (const version of await a.versionsInRange()) {
    await a.collect(version);
  }
  await a.addAdvisories();
  return a.cl;
}
