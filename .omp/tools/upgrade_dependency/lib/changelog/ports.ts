import type { Advisory, Ecosystem, Range } from "../schemas.js";

// Port of agentmux internal/changelog/ports.go: the outside reads Assemble performs. The live adapters
// over gh, npm and osv are the wiring task's; gather only defines and consumes the ports.

/** A port cannot answer for this ecosystem or host (ErrUnsupported). Compare by identity. */
export const ERR_UNSUPPORTED = new Error("changelog: not supported");

/** The thing asked for does not exist upstream (ErrNotFound). Compare by identity. */
export const ERR_NOT_FOUND = new Error("changelog: not found");

/** Repo is the GitHub repository a package is published from. Directory is the package's folder inside a monorepo, empty when it is the whole repo. */
export interface Repo {
  owner: string;
  name: string;
  directory: string;
}

/** Slug is "owner/name". */
export function repoSlug(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** URL is the repository's web address. */
export function repoUrl(repo: Repo): string {
  return `https://github.com/${repoSlug(repo)}`;
}

/** ReleasesTrackPackage reports whether a bare version tag ("v1.2.3") in this repository is a release of the package itself, rather than of a sibling package in the same monorepo. */
export function releasesTrackPackage(repo: Repo): boolean {
  if (repo.directory === "") return true;
  const cut = repo.directory.lastIndexOf("/");
  return (cut < 0 ? repo.directory : repo.directory.slice(cut + 1)) === repo.name;
}

/** Release is one published release of a repository. */
export interface Release {
  tag: string;
  body: string;
  url: string;
}

/** Registry resolves a package to where its source and versions live. */
export interface Registry {
  source(eco: Ecosystem, pkg: string): Promise<Repo>;
  versions(eco: Ecosystem, pkg: string): Promise<string[]>;
}

/** Releases reads a repository's published release notes and files. */
export interface Releases {
  list(repo: Repo): Promise<Release[]>;
  /** File returns the file at path as of ref (empty ref is the default branch), or throws ERR_NOT_FOUND. */
  file(repo: Repo, ref: string, path: string): Promise<string>;
}

/** Advisories reads published security advisories for a package upgrade. */
export interface Advisories {
  for(range: Range): Promise<Advisory[]>;
}

/** Ports is everything Assemble reads from outside (changelog.Ports). */
export interface Ports {
  registry: Registry;
  releases: Releases;
  advisories: Advisories;
}

/** The changelog ports a gather depends on (the pinned gather seam's `changelog`). */
export type ChangelogPorts = Ports;

export function validatePorts(ports: Ports): void {
  if (!ports.registry || !ports.releases || !ports.advisories) {
    throw new Error("changelog: registry, releases, and advisories ports are all required");
  }
}
