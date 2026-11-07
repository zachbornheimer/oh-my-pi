import { packageAliases } from "./aliases.js";
import type { PackageAliases } from "./aliases.js";
import { Assemble } from "./changelog/assemble.js";
import type { ChangelogPorts } from "./changelog/ports.js";
import { facadeFor } from "./facade.js";
import { ClassifyPath } from "./files.js";
import type { ConfigFiles, Import, Invocation, Peers, Tree } from "./ports.js";
import type { Changelog, Ecosystem, Facts, File, Package, PackageFacts, Snapshot } from "./schemas.js";
import { MatchEntries, usedSymbols } from "./symbols.js";
import { DiffTests } from "./testdiff.js";
import { unitNames, unitOf, units } from "./units.js";

// Port of agentmux internal/depupgrade/facts.go: everything the judge reads, none of it guessed. A source
// that cannot be read is recorded in Facts.gaps; only an unusable port or a failed tree search throws.

/** The outside reads one gather performs (ports.go Ports, with the pinned seam's names). */
export interface GatherPorts {
  tree: Tree;
  config: ConfigFiles;
  peers: Peers;
  changelog: ChangelogPorts;
  root: string;
}

/** manifestEcosystems maps a manifest's file name to the package ecosystem. */
const MANIFEST_ECOSYSTEMS: Readonly<Record<string, Ecosystem>> = {
  "package.json": "npm",
  "go.mod": "go",
  "composer.json": "composer",
  "pyproject.toml": "pypi",
  "requirements.txt": "pypi",
};

/** docSuffixes mark prose files, which mention packages without importing them. */
const DOC_SUFFIXES = [".md", ".mdx", ".txt", ".rst"];

const ERR_PORTS_REQUIRED = "depupgrade: tree, config, and peers ports are required";

function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/** EcosystemOf reads the ecosystem from the first changed manifest, or "". */
export function EcosystemOf(files: File[]): Ecosystem {
  for (const file of files) {
    if (!file.manifest) continue;
    const eco = MANIFEST_ECOSYSTEMS[baseName(file.path ?? "")];
    if (eco !== undefined) return eco;
  }
  return "";
}

/** isCodeFile: a test, manifest, lockfile or prose file mentions a package without importing it. */
export function isCodeFile(path: string): boolean {
  const file = ClassifyPath(path);
  return !file.test && !file.manifest && !file.lockfile && !DOC_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

async function collectImports(tree: Tree, root: string, pkg: Package, aliases: string[]): Promise<Import[]> {
  const out: Import[] = [];
  for (const name of [pkg.name, ...aliases]) {
    const found = await tree.imports(root, name);
    for (const imp of found) {
      if (isCodeFile(imp.path)) out.push(imp);
    }
  }
  return out;
}

/**
 * collectExecutions: every line in the working copy that runs the package's binary, in any language. An
 * import graph cannot see these — the caller is a script in another language naming the executable — so
 * they are searched for separately, under the package's name and the bare name a scoped package installs.
 */
async function collectExecutions(tree: Tree, root: string, pkg: Package, aliases: string[]): Promise<Invocation[]> {
  const names = new Set<string>([pkg.name, ...aliases]);
  const unscoped = pkg.name.split("/").at(-1);
  if (unscoped !== undefined && unscoped !== "") names.add(unscoped);
  const out: Invocation[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const line of await tree.executions(root, name)) {
      if (!isCodeFile(line.path)) continue;
      const key = `${line.path}:${line.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

function distinctPaths(imports: Import[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const imp of imports) {
    if (!seen.has(imp.path)) {
      seen.add(imp.path);
      out.push(imp.path);
    }
  }
  return out;
}

/** changelogFor assembles the range's notes; a source that cannot be assembled is a gap, never a throw. */
async function changelogFor(
  ports: GatherPorts,
  eco: Ecosystem,
  snapshot: Snapshot,
  pkg: Package,
  record: (message: string) => void,
): Promise<Changelog> {
  const range = { ecosystem: eco, package: pkg.name, from: pkg.from, to: pkg.to };
  try {
    return await Assemble(range, ports.changelog, snapshot.notes ?? []);
  } catch (error) {
    const message = (error as Error).message;
    record(`changelog for ${pkg.name} ${pkg.from} to ${pkg.to}: ${message}`);
    return { range, entries: [], advisories: [], sources: [], gaps: [message] };
  }
}

async function packageFactsFor(
  ports: GatherPorts,
  eco: Ecosystem,
  snapshot: Snapshot,
  pkg: Package,
  aliases: PackageAliases,
  record: (message: string) => void,
): Promise<PackageFacts> {
  const [imports, executions] = await Promise.all([
    collectImports(ports.tree, ports.root, pkg, aliases.names),
    collectExecutions(ports.tree, ports.root, pkg, aliases.names),
  ]);
  const importers = distinctPaths(imports);
  const symbols = await usedSymbols(ports.tree, ports.root, eco, imports);
  const changelog = await changelogFor(ports, eco, snapshot, pkg, record);
  const facts: PackageFacts = {
    package: pkg,
    changelog,
    aliases: aliases.names,
    importers,
    import_sites: imports,
    used_symbols: symbols,
    matched_entries: MatchEntries(changelog.entries, symbols),
    unit: "",
    facade: facadeFor(importers, aliases.facadeExempt),
  };
  // Go's `omitempty` drops this when empty, so it is absent rather than empty.
  if (aliases.evidence.length > 0) facts.alias_evidence = aliases.evidence;
  if (executions.length > 0) facts.executions = executions;
  return facts;
}

function validatePorts(ports: GatherPorts): void {
  if (ports.tree === undefined || ports.config === undefined || ports.peers === undefined) {
    throw new Error(ERR_PORTS_REQUIRED);
  }
}

/**
 * Gather computes the Facts for a Snapshot (facts.go Gather). A source that cannot be read is recorded in
 * Facts.gaps; only an unusable port or a failed tree search throws.
 */
export async function gatherFacts(snapshot: Snapshot, ports: GatherPorts): Promise<Facts> {
  validatePorts(ports);
  const eco = EcosystemOf(snapshot.files);
  const gaps: string[] = [];
  const record = (message: string) => gaps.push(message);
  const unitList = await units(ports.peers, eco, snapshot.packages, record);
  const aliases = await packageAliases(ports.config, ports.root, snapshot.packages, record);
  const packages: PackageFacts[] = [];
  for (const pkg of snapshot.packages) {
    const pkgAliases = aliases.get(pkg.name) ?? { names: [], evidence: [], facadeExempt: false };
    const facts = await packageFactsFor(ports, eco, snapshot, pkg, pkgAliases, record);
    facts.unit = unitOf(unitList, pkg.name);
    packages.push(facts);
  }
  const facts: Facts = {
    ecosystem: eco,
    packages,
    units: unitNames(unitList),
    test_diff: DiffTests(snapshot.files),
    ci: snapshot.ci ?? [],
    lockfile: snapshot.files.filter((file) => file.lockfile).map((file) => file.path ?? ""),
    manifest: snapshot.files.filter((file) => file.manifest).map((file) => file.path ?? ""),
  };
  if (gaps.length > 0) facts.gaps = gaps;
  return facts;
}
