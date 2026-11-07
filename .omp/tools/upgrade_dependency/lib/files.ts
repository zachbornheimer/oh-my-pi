import type { File } from "./schemas.js";

// Go internal/depupgrade/files.go ClassifyPath: what one changed path is, so the judge can tell a lockfile
// from a manifest from a test.

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "composer.lock",
  "uv.lock",
  "poetry.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "mise.lock",
  "packages.lock.json",
  ".terraform.lock.hcl",
]);

const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "composer.json",
  "pyproject.toml",
  "Cargo.toml",
  "Gemfile",
  "cpanfile",
  "requirements.txt",
  "mise.toml",
]);

/** A manifest whose file name carries a project-specific stem, so the extension decides: an MSBuild project. */
const MANIFEST_SUFFIXES = [".csproj"];

const TEST_SUFFIXES = [
  "_test.go",
  ".test.js",
  ".test.ts",
  ".test.tsx",
  ".spec.js",
  ".spec.ts",
  ".spec.tsx",
  "_test.py",
  ".t",
];

const TEST_DIRECTORIES = ["/__tests__/", "/testdata/"];

/** Go's `path/filepath.Base` for the slash-separated paths a pull request reports. */
function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

function isTestPath(path: string): boolean {
  if (TEST_DIRECTORIES.some((directory) => path.includes(directory))) return true;
  return TEST_SUFFIXES.some((suffix) => baseName(path).endsWith(suffix));
}

/**
 * A GitHub Actions workflow or composite action file. A `uses: owner/repo@<sha>` pin in one is the dependency and its
 * own lock: no manifest names it and no installer has a lockfile to rewrite for it.
 */
export function isActionsPin(path: string): boolean {
  return /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(path);
}

/**
 * Files whose only dependency is a git ref pin, or the policy for such pins. Same as an Actions pin: the ref is the lock.
 * Trunk's and lefthook's dev-config refs are pins; pinact's configuration (every path pinact reads it from) records
 * which Actions refs a repository accepts, such as an untagged reusable-workflow SHA, and has no lockfile either. zizmor's
 * configuration (every path zizmor reads it from) accepts the by-design findings its pin rules raise in a synced workflow
 * — an org-wide App token, persisted checkout credentials, an `@main` reusable call — so it is a policy for the pins too.
 */
const SCAFFOLD_REF_PINS: Record<string, true> = {
  ".trunk/trunk.yaml": true,
  "lefthook.yml": true,
  ".pinact.yaml": true,
  ".pinact.yml": true,
  ".github/pinact.yaml": true,
  ".github/pinact.yml": true,
  "zizmor.yml": true,
  "zizmor.yaml": true,
  ".github/zizmor.yml": true,
  ".github/zizmor.yaml": true,
};

/**
 * A changed path that pins a git ref and has no package lockfile to rewrite: a GitHub Actions workflow, a platform
 * scaffold pointer (Trunk's dev-config ref, lefthook's dev-config ref), or pinact's or zizmor's policy for those pins.
 */
export function isOwnLock(path: string): boolean {
  return isActionsPin(path) || SCAFFOLD_REF_PINS[path] === true;
}

/** Marks a changed path as lockfile, manifest, and/or test; a flag Go would omit stays unset. */
export function ClassifyPath(path: string): File {
  const file: File = { path };
  const base = baseName(path);
  if (LOCKFILES.has(base)) file.lockfile = true;
  if (MANIFESTS.has(base) || MANIFEST_SUFFIXES.some((suffix) => base.endsWith(suffix))) file.manifest = true;
  if (isTestPath(path)) file.test = true;
  return file;
}
