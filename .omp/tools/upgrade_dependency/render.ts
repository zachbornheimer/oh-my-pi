import { isOwnLock } from "./lib/files.js";
import type { Facts, Snapshot } from "./lib/schemas.js";
import type { Gate } from "./loop/run.js";
import { SCHEMA_LEAD } from "./prompts.js";
import type { Changelog, Changes, FacadePlan, Usages } from "./schemas.js";
import type { LockfileStatus } from "./upgrade_host.js";

/**
 * The input text each prompt reads, and the deterministic gates the report rests on. Everything here is an
 * observation: the prompts decide, this file only lays out what was seen and refuses to invent what was not.
 */

const fence = (text: string): string => `\`\`\`\n${text.trim()}\n\`\`\``;

/**
 * The prompt, with the schema the decoder accepts. A prompt built for a question asks for the schema of the reply
 * itself; this replaces whatever schema tail the prompt has with `schema`, so a model that follows the pasted schema
 * is not rejected by the decoder.
 */
export function promptForDecoder(prompt: string, schema: Readonly<Record<string, unknown>>): string {
  const cut = prompt.lastIndexOf(SCHEMA_LEAD);
  const body = cut < 0 ? prompt : prompt.slice(0, cut);
  return `${body}${SCHEMA_LEAD}${JSON.stringify(schema)}`;
}

const rangeOf = (changes: Changes): string =>
  changes.packages.map((pkg) => `${pkg.name} ${pkg.from} → ${pkg.to}`).join(", ");

/** What the pull request changes: every changed file with its patch, and the description Renovate wrote. */
export function renderChanges(snapshot: Snapshot): string {
  const files = snapshot.files
    .map((file) => `### ${file.path}\n${file.patch ? fence(file.patch) : "(no patch reported)"}`)
    .join("\n\n");
  return `Pull request: ${snapshot.url}\nTitle: ${snapshot.title}\n\n## The pull request description\n\n${snapshot.body}\n\n## Changed files (${snapshot.files.length})\n\n${files}`;
}

/** The longest description the qualifies question reads, in characters: Renovate's preview of later pull requests is long. */
const QUALIFIES_BODY_CHARS = 4000;

/** The longest patch the qualifies question reads, in characters. A larger one is named by path only. */
const QUALIFIES_PATCH_CHARS = 1500;

/**
 * What the qualifies question reads: the title, the description, and every changed path, with its diff when the diff
 * is small enough to read. The facts are left out on purpose, so the answer rests on the pull request itself.
 */
export function renderQualifies(snapshot: Snapshot) {
  return {
    title: snapshot.title ?? "",
    description: snapshot.body.slice(0, QUALIFIES_BODY_CHARS),
    changed_files: snapshot.files.map((file) => ({
      path: file.path,
      ...(file.patch && file.patch.length <= QUALIFIES_PATCH_CHARS ? { diff: file.patch } : {}),
    })),
  };
}

/** The release-notes part of the description: what a changelog step needs, without the upgrade page's furniture. */
function releaseNotesOf(body: string): string {
  const start = body.search(/### Release Notes|<details>/);
  if (start < 0) return body;
  const end = body.indexOf("### Configuration", start);
  return end < 0 ? body.slice(start) : body.slice(start, end);
}

/** The range to research, with the notes the pull request already carries as a starting reference. */
export function renderChangelogInput(changes: Changes, snapshot: Snapshot): string {
  const packages = changes.packages
    .map((pkg) => `- ${pkg.name}: ${pkg.from} → ${pkg.to} (${pkg.evidence})`)
    .join("\n");
  return `Upgrading: ${rangeOf(changes)}\n\n${packages}\n\n## Notes the upgrade pull request already carries\n\n${
    releaseNotesOf(snapshot.body)
  }`;
}

/** The package to trace, with the facts the gatherer already read as evidence to start from. */
export function renderUsageInput(changes: Changes, changelog: Changelog, snapshot: Snapshot): string {
  const facts: Facts | undefined = snapshot.facts;
  const packages = (facts?.packages ?? []).map((pkg) =>
    [
      `- ${pkg.package.name} ${pkg.package.from} → ${pkg.package.to}`,
      `  importers the tree search found: ${pkg.importers.length === 0 ? "none" : pkg.importers.join(", ")}`,
      `  import sites: ${
        pkg.import_sites.map((site) => `${site.path}:${site.line} ${site.statement.trim()}`).join(" | ") || "none"
      }`,
      `  lines that run its binary: ${
        (pkg.executions ?? []).map((line) => `${line.path}:${line.line} ${line.statement.trim()}`).join(" | ")
        || "none the search found"
      }`,
      `  symbols read through it: ${pkg.used_symbols.join(", ") || "none"}`,
    ].join("\n")
  );
  const redLog = facts?.red_log;
  const failure = redLog
    ? `## Failed check log\n\nA red check is the canary. If it names this package or a caller of it, that caller is part of this upgrade.\n\n${redLog}`
    : "## Failed check log\n\n(no failed check log)";
  const entries = changelog.packages
    .map((pkg) =>
      `- ${pkg.name}: ${
        pkg.entries.map((entry) => `${entry.version} (${entry.kind})`).join(", ") || "no entries grounded"
      }`
    )
    .join("\n");
  return `Working copy: ${facts ? "read by the gatherer" : "(no facts gathered)"}\n\n## Packages to trace\n\n${
    packages.join("\n") || "- (none)"
  }\n\n## The changelog entries to weigh each usage against\n\n${entries || "- (none)"}\n\n${failure}`;
}

/** The usages and entries the facade decision rests on, with the doc's own proportionality rule. */
export function renderFacadeInput(usage: Usages, changelog: Changelog): string {
  const usages = usage.usages
    .map((use) =>
      `- ${use.package}: ${use.how} at ${use.file}${
        use.line ? `:${use.line}` : ""
      } (basis ${use.basis}) — ${use.evidence} — touched: ${use.touched || "nothing"}`
    )
    .join("\n");
  const entries = changelog.packages
    .map((pkg) =>
      `- ${pkg.name}: ${
        pkg.entries.map((entry) => `${entry.version} ${entry.kind}: ${entry.text}`).join(" | ") || "no entries grounded"
      }`
    )
    .join("\n");
  return `## How this codebase reaches the package\n\n${
    usages || "- (no usage traced)"
  }\n\n## What changed in the range\n\n${
    entries || "- (none grounded)"
  }\n\n## The checklist\n\nOne or two call sites, or a dev-only tool: a facade is optional. Widespread use, or any system boundary (a process, an HTTP client, a store, an external SDK): a facade is required in this change.`;
}

/** The material the PR body is written from: the change, the entries, the usages, and the plan. */
export function renderBodyInput(changes: Changes, changelog: Changelog, usage: Usages, facade: FacadePlan): string {
  const entries = changelog.packages
    .map((pkg) =>
      `- ${pkg.name}: ${
        pkg.entries.map((entry) => `${entry.version} (${entry.kind}) ${entry.text}`).join(" | ")
        || "no entries grounded"
      }`
    )
    .join("\n");
  const usages = usage.usages.map((use) =>
    `- ${use.package} ${use.how} at ${use.file} — ${use.touched || "nothing in the range touches it"}`
  ).join("\n");
  const plan = facade.needed
    ? `facade ${facade.name} in ${facade.path}, owning ${facade.owns}; steps: ${
      facade.steps.map((step) => `${step.order}. ${step.what} (green when ${step.green_when})`).join("; ")
    }`
    : `no facade: ${facade.reason}`;
  return `Headings to use, in order: ${
    changes.packages.map((pkg) => `"${pkg.name} ${pkg.from} → ${pkg.to}"`).join(", ")
  }\n\n## Changelog entries\n\n${entries || "- (none grounded)"}\n\n## How this codebase reaches the packages\n\n${
    usages || "- (no usage traced)"
  }\n\n## The upgrade work\n\n${plan}`;
}

/** What one lockfile status says, in the words the gate reports. */
function describeLockfile(status: LockfileStatus): string {
  switch (status.state) {
    case "in_pull_request":
      return `${status.lockfile} in the pull request`;
    case "rewritten":
      return `${status.lockfile} rewritten and committed by ${status.via}`;
    case "unchanged":
      return `${status.lockfile} unchanged by ${status.via}`;
    case "stale":
      return `${status.lockfile} is stale and could not be rewritten: ${status.reason}`;
    case "absent":
      return `no lockfile for ${status.manifest} (${status.lockfiles.join(", ")})`;
    case "unsupported":
      return `${status.manifest} has no lockfile installer`;
  }
}

/**
 * `lockfile_committed`: the lockfile nearest each changed manifest is current once its install has run. It fails when
 * one is stale and could not be rewritten, and when nothing in the pull request says a lockfile is current: a manifest
 * with no installer needs a lockfile in the diff. When no manifest changed, no lockfile is owed (the gate passes) if
 * the pull request claims no upgrade, the head changes no files, or every changed file is a git-ref pin (a GitHub
 * Actions workflow, a platform scaffold pointer such as `.trunk/trunk.yaml` or `lefthook.yml`, or pinact's
 * `.pinact.yaml` or zizmor's `.github/zizmor.yml` policy for those pins), which is its own lock. A pull request that
 * claims an upgrade yet changed no manifest, lockfile or pin, and did change some other file, has nothing to point at
 * and fails.
 */
function lockfileGate(
  manifests: readonly string[],
  upgradeClaimed: boolean,
  inDiff: readonly string[],
  statuses: readonly LockfileStatus[],
  changedPaths: readonly string[],
): Gate {
  const name = "lockfile_committed";
  if (manifests.length === 0 && statuses.length === 0 && inDiff.length === 0) {
    if (changedPaths.every(isOwnLock)) {
      return {
        name,
        verdict: "passed",
        observed: changedPaths.length === 0
          ? "no files changed, so no lockfile is owed"
          : `no manifest changed; ${changedPaths.join(", ")} pin a git ref, which has no lockfile`,
      };
    }
    if (!upgradeClaimed) {
      return { name, verdict: "passed", observed: "no manifest changed and no upgrade claimed, so no lockfile is owed" };
    }
  }
  const stale = statuses.filter((status) => status.state === "stale");
  if (stale.length > 0) return { name, verdict: "failed", observed: stale.map(describeLockfile).join("; ") };
  const unsupported = statuses.some((status) => status.state === "unsupported");
  const current = statuses.some((status) => status.state !== "unsupported");
  if (unsupported ? inDiff.length === 0 : !current && inDiff.length === 0) {
    return { name, verdict: "failed", observed: "no lockfile in the changed files" };
  }
  const covered = new Set(statuses.flatMap((status) => "lockfile" in status ? [status.lockfile] : []));
  const observed = [
    ...statuses.filter((status) => status.state !== "unsupported").map(describeLockfile),
    ...inDiff.filter((path) => !covered.has(path)).map((path) => `${path} in the pull request`),
  ];
  return { name, verdict: "passed", observed: observed.join("; ") };
}

/**
 * The deterministic gates the pull request loop judges the pull request with, on every reading of its head: what the
 * reference doc asks that no model judgment can decide, except `ci`, which the loop reads itself. `lockfiles` is where
 * the lockfile step left each lockfile.
 */
export function checkedGates(
  snapshot: Snapshot,
  changes: Changes,
  lockfiles: readonly LockfileStatus[],
): Gate[] {
  const facts = snapshot.facts;
  const gates: Gate[] = [];
  const units = facts?.units ?? [];

  gates.push(
    changes.packages.length <= 1 || units.length <= 1
      ? {
        name: "one_dependency_per_commit",
        verdict: "passed",
        observed: changes.packages.length === 0
          ? "no dependency upgraded"
          : `1 unit: ${changes.packages.map((pkg) => pkg.name).join(", ")}`,
      }
      : {
        name: "one_dependency_per_commit",
        verdict: "failed",
        observed: `${units.length} units: ${units.map((unit) => unit.join(" + ")).join("; ")}`,
      },
  );

  gates.push(
    lockfileGate(
      facts?.manifest ?? [],
      changes.packages.length > 0,
      facts?.lockfile ?? [],
      lockfiles,
      snapshot.files.flatMap((file) => file.path ? [file.path] : []),
    ),
  );

  const testDiff = facts?.test_diff;
  gates.push(
    (testDiff?.suspicious?.length ?? 0) > 0
      ? {
        name: "tests_unweakened",
        verdict: "failed",
        observed: `${testDiff?.suspicious.length} suspicious test lines, first: ${testDiff?.suspicious[0]?.kind} in ${
          testDiff?.suspicious[0]?.path
        }`,
      }
      : (testDiff?.changed?.length ?? 0) > 0
      ? {
        name: "tests_unweakened",
        verdict: "not_proven",
        observed: `test files changed, no removed assertion or added skip: ${testDiff?.changed.join(", ")}`,
      }
      : { name: "tests_unweakened", verdict: "passed", observed: "no test files changed" },
  );

  return gates;
}

/**
 * Every gate: the ones `checkedGates` reads, then `ci`, the pull request loop's own verdict on the pull request as it
 * stands now (its first line says done, impossible or spent, then why), not the snapshot's checks from before the run.
 */
export function gatesOf(
  snapshot: Snapshot,
  changes: Changes,
  ci: { green: boolean; reason: string },
  lockfiles: readonly LockfileStatus[],
): Gate[] {
  return [
    ...checkedGates(snapshot, changes, lockfiles),
    { name: "ci", verdict: ci.green ? "passed" : "failed", observed: ci.reason },
  ];
}
