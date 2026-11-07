import { ClassifyPath } from "./lib/files.js";
import type { Snapshot } from "./lib/schemas.js";
import { DiffTests } from "./lib/testdiff.js";
import type { Facts as LoopFacts } from "./loop/types.js";
import type { Gate, PrGates, PrLoopResult } from "./loop/run.js";
import { parsePullRequestUrl } from "./loop/parse_url.js";
import { askJson, type ModelStep } from "./omp_model.js";
import {
  CHANGELOG,
  CHANGELOG_TOOLS_NOTE,
  CHANGES,
  FACADE,
  languagePrompt,
  PR_BODY,
  QUALIFIES,
  qualifiesPrompt,
  USAGE,
  USAGE_TOOLS_NOTE,
} from "./prompts.js";
import {
  checkedGates,
  gatesOf,
  promptForDecoder,
  renderBodyInput,
  renderChangelogInput,
  renderChanges,
  renderFacadeInput,
  renderQualifies,
  renderUsageInput,
} from "./render.js";
import {
  type Changelog,
  type Changes,
  decodeBody,
  decodeChangelog,
  decodeChanges,
  decodeFacade,
  decodeKind,
  decodeUsages,
  type FacadePlan,
  type PrBody,
  type PullRequestKind,
  type UpgradeReport,
  type UpgradeVerdict,
  type Usages,
} from "./schemas.js";
import type { LockfileState, LockfileStatus, UpgradeHost } from "./upgrade_host.js";

/**
 * One atomic upgrade. A closed-choice model reply first says whether the pull request is a dependency upgrade at all.
 * If it is, five prompts name the range, the changelog, the callers, the facade, and the pull-request body. The
 * lockfile the bump left behind is brought up to date and pushed, then the pull request loop (target mergeable, never
 * merging) works the pull request until it is done, impossible or spent, with this upgrade's gates among its exit
 * criteria. Only a pull request whose loop ended done or merged, with no failed gate, is labeled checked and armed for
 * automerge. A dependency bot's config-only pull request skips the prompts and goes through the same loop. Any other
 * pull request is reported `skipped` with no effect at all.
 */

/** Every effect of a run. The tool wires the real ones; tests substitute fakes. */
export interface UpgradeDeps {
  /** One model call: prompt text in, reply text out. No tools. */
  readonly model: ModelStep;
  /**
   * A model step with read-only tools (read, grep, find, web_search) on a checkout of the pull request head. Used for
   * the changelog and usage prompts only; the other four steps use `model`.
   */
  readonly research: (prUrl: string) => Promise<ModelStep>;
  readonly host: UpgradeHost;
  /** The pull request loop, aimed at mergeable and never merging, with the caller's gates among its exit criteria. */
  readonly loop: (input: { prUrl: string; gates: PrGates }) => Promise<PrLoopResult>;
  /** Reads the pull request and its facts; throws when the facts cannot be read. */
  readonly gather: (prUrl: string) => Promise<Snapshot>;
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  /** Names the step now running. */
  readonly progress: (message: string) => void;
  readonly signal?: AbortSignal;
}

export interface UpgradeResult extends UpgradeReport {
  seconds: number;
}

const NO_CHANGES: Changes = { packages: [] };
const SKIPPED_SECTIONS = {
  changes: NO_CHANGES,
  changelog: { packages: [] } as Changelog,
  usages: [],
  facade: {
    needed: false,
    reason: "The pull request upgrades no dependency, so there is nothing to wrap.",
    steps: [],
  } satisfies FacadePlan,
  body: { units: [] } as PrBody,
};

/** A version the model could not read from the diff and wrote as a placeholder. */
const UNKNOWN_VERSION = /^\s*unknown\b/i;

function refuse(reason: string): never {
  throw new Error(reason);
}

const within = (version: string, from: string, to: string): boolean =>
  version === to
  || (version !== from
    && version.localeCompare(from, undefined, { numeric: true }) > 0
    && version.localeCompare(to, undefined, { numeric: true }) < 0);

export function acceptChanges(reply: Changes): Changes {
  if (reply.packages.length === 0) {
    refuse(
      "this pull request was found to upgrade a dependency: name it from the manifest or lockfile lines it changes, never from packages the description says later pull requests will upgrade",
    );
  }
  for (const pkg of reply.packages) {
    if (!pkg.name || !pkg.from || !pkg.to) refuse("every package needs its name and the version it moves from and to");
    if (UNKNOWN_VERSION.test(pkg.from) || UNKNOWN_VERSION.test(pkg.to)) {
      refuse(
        `${pkg.name} has no version read from the changed lines: ${pkg.from} → ${pkg.to}. Take both versions from the diff of a changed manifest or lockfile, and drop a package the diff does not show`,
      );
    }
    if (!pkg.evidence) refuse(`say which changed file and lines showed ${pkg.name} ${pkg.from} → ${pkg.to}`);
  }
  return reply;
}

export function acceptChangelog(reply: Changelog, changes: Changes): Changelog {
  const known = new Map(changes.packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of reply.packages) {
    const range = known.get(pkg.name);
    if (!range) refuse(`"${pkg.name}" is not one of the packages being upgraded (${[...known.keys()].join(", ")})`);
    for (const entry of pkg.entries) {
      if (!within(entry.version, range.from, range.to)) {
        refuse(`entry ${entry.version} of ${pkg.name} is outside the range being crossed (${range.from} → ${range.to})`);
      }
      if (!entry.url) refuse(`entry ${entry.version} of ${pkg.name} names no reference URL: cite what you read`);
      if (!entry.text) refuse(`entry ${entry.version} of ${pkg.name} says what changed but not what it means`);
    }
  }
  return reply;
}

export function acceptUsages(reply: Usages): Usages {
  for (const use of reply.usages) {
    if (!use.package || !use.file || !use.evidence) {
      refuse("every usage needs the package, the file, and the evidence you read it from");
    }
    if (!use.basis) refuse(`say how you established the usage at ${use.file}: a graph, a lockfile trace, or reading it`);
  }
  return reply;
}

export function acceptFacade(reply: FacadePlan): FacadePlan {
  if (!reply.reason) refuse("say why this upgrade needs a facade, or why it does not");
  if (!reply.needed) return reply;
  if (!reply.name || !reply.path) refuse("a needed facade needs its name and the file it lives in");
  if (reply.steps.length === 0) {
    refuse("a needed facade needs its ordered steps, the first being the tests that characterize today's behavior");
  }
  return reply;
}

export function acceptBody(reply: PrBody, changes: Changes): PrBody {
  if (reply.units.length !== changes.packages.length) {
    refuse(`answer for exactly ${changes.packages.length} package(s), one heading each, in the order given`);
  }
  return reply;
}

/**
 * The snapshot's facts. The gatherer fails the whole run when it cannot read them, so a snapshot without facts is
 * refused up front: the lockfile and the gates need them.
 */
function requireFacts(snapshot: Snapshot): NonNullable<Snapshot["facts"]> {
  return snapshot.facts
    ?? refuse("upgrade_dependency needs the snapshot's facts (ecosystem, packages, call sites); this snapshot has none");
}

/**
 * The gates the loop reads on every reading of the head. A head a fix round pushed is read again: its changed files,
 * including each patch, replace the snapshot's, its upgrade units are re-derived from the body the head carries, and
 * `tests_unweakened` is judged from that diff, not from the diff the run started with. The lockfile statuses stand
 * while the head is the one they were read at; settling a new head can itself push a rewritten lockfile, so that
 * reading fails and the next reading, of the new head, passes.
 */
export function callerGates(
  host: UpgradeHost,
  snapshot: Snapshot,
  changes: Changes,
  start: LockfileState,
): {
  readonly gates: PrGates;
  readonly lockfiles: () => readonly LockfileStatus[];
  readonly viewed: () => Snapshot;
} {
  const manifests = snapshot.facts?.manifest ?? [];
  const committed = snapshot.facts?.lockfile ?? [];
  let state = start;
  let checkedAt = start.head;
  let viewed = snapshot;
  return {
    lockfiles: () => state.statuses,
    viewed: () => viewed,
    gates: async (reading: LoopFacts): Promise<Gate[]> => {
      let pushed = false;
      if (reading.headSha !== checkedAt) {
        const changed = await host.currentChangedFiles(reading.repo, reading.number);
        const paths = changed?.map((file) => file.path);
        const currentManifests = paths === undefined
          ? manifests
          : paths.filter((path) => ClassifyPath(path).manifest === true);
        const currentLockfiles = paths === undefined
          ? committed
          : paths.filter((path) => ClassifyPath(path).lockfile === true);
        if (changed !== undefined) {
          const files = changed.map((file) => ({
            ...ClassifyPath(file.path),
            ...(file.patch === "" ? {} : { patch: file.patch }),
          }));
          const headUnits = await host.currentHeadUnits(reading.repo, reading.number, snapshot.facts?.ecosystem ?? "");
          viewed = {
            ...snapshot,
            files,
            facts: {
              ...snapshot.facts,
              ecosystem: snapshot.facts?.ecosystem ?? "",
              packages: snapshot.facts?.packages ?? [],
              units: headUnits ?? snapshot.facts?.units ?? [],
              ci: snapshot.facts?.ci ?? [],
              manifest: [...currentManifests],
              lockfile: [...currentLockfiles],
              test_diff: DiffTests(files),
            },
          };
        }
        state = await host.resettleLockfiles(currentManifests, currentLockfiles);
        checkedAt = reading.headSha;
        pushed = state.statuses.some((status) => status.state === "rewritten");
      }
      const gates = checkedGates(viewed, changes, state.statuses);
      if (!pushed) return gates;
      return gates.map((gate) =>
        gate.name === "lockfile_committed"
          ? { ...gate, verdict: "failed" as const, observed: `${gate.observed}; pushed as a new head not yet read` }
          : gate
      );
    },
  };
}

/** What the `ci` gate says about a loop result: its text, plus every reason the text does not already carry. */
function loopObservation(result: PrLoopResult): string {
  const missing = result.reasons.filter((reason) => !result.text.includes(reason));
  return missing.length === 0 ? result.text : `${result.text}\n${missing.join("\n")}`;
}

/**
 * The pull request loop on the pull request, with the gates as exit criteria, then the verdict: ready only when the
 * loop ended done or merged, no gate failed and automerge armed (which also labels it).
 */
async function driveLoop(
  deps: UpgradeDeps,
  snapshot: Snapshot,
  url: string,
  changes: Changes,
  lockfiles: LockfileState,
): Promise<{ gates: Gate[]; verdict: Exclude<UpgradeVerdict, "skipped"> }> {
  const caller = callerGates(deps.host, snapshot, changes, lockfiles);
  deps.progress("pull request loop");
  let ci: { green: boolean; reason: string; merged: boolean };
  try {
    const result = await deps.loop({ prUrl: url, gates: caller.gates });
    ci = {
      green: result.status === "done" || result.status === "merged",
      reason: loopObservation(result),
      merged: result.status === "merged",
    };
  } catch (error) {
    deps.signal?.throwIfAborted();
    ci = { green: false, reason: (error as Error).message, merged: false };
  }
  const gates = gatesOf(caller.viewed(), changes, ci, caller.lockfiles());
  if (gates.some((gate) => gate.verdict === "failed")) return { gates, verdict: "needs_work" };
  if (ci.merged) return { gates, verdict: "ready" };
  deps.progress("automerge");
  const armed = await deps.host.armPullRequest();
  return { gates, verdict: armed.armed ? "ready" : "needs_work" };
}

/** Runs one upgrade end to end. Throws when the pull request cannot be read or a model step never produces a valid reply. */
export async function upgradeDependency(deps: UpgradeDeps, url: string): Promise<UpgradeResult> {
  parsePullRequestUrl(url);
  const began = deps.clock();
  const finish = (report: UpgradeReport): UpgradeResult => ({
    ...report,
    seconds: Math.round((deps.clock() - began) / 1000),
  });
  const ask = <T>(
    label: string,
    prompt: string,
    validate: (value: unknown) => T,
    step: ModelStep = deps.model,
  ): Promise<T> => {
    deps.progress(label);
    return askJson(step, prompt, validate, { signal: deps.signal });
  };

  deps.progress("reading the pull request");
  const snapshot = await deps.gather(url);
  const facts = requireFacts(snapshot);

  const kind: PullRequestKind = await ask(
    "qualifies",
    qualifiesPrompt(QUALIFIES, renderQualifies(snapshot)),
    (value) => decodeKind(value, QUALIFIES.field),
  );
  if (kind === "not_dependency") return finish({ url, kind, ...SKIPPED_SECTIONS, gates: [], verdict: "skipped" });

  const settle = async (): Promise<LockfileState> => {
    deps.progress("lockfile");
    return deps.host.settleLockfiles(facts.manifest, facts.lockfile);
  };
  if (kind === "config_only") {
    const lockfiles = await settle();
    const { gates, verdict } = await driveLoop(deps, snapshot, url, NO_CHANGES, lockfiles);
    return finish({ url, kind, ...SKIPPED_SECTIONS, gates, verdict });
  }

  deps.progress("checking out the pull request head for research");
  const research = await deps.research(url);
  const changes = await ask(
    "changes",
    promptForDecoder(languagePrompt(CHANGES, renderChanges(snapshot)), CHANGES.schema),
    (value) => acceptChanges(decodeChanges(value)),
  );
  const changelog = await ask(
    "changelog",
    promptForDecoder(
      languagePrompt(CHANGELOG, renderChangelogInput(changes, snapshot), CHANGELOG_TOOLS_NOTE),
      CHANGELOG.schema,
    ),
    (value) => acceptChangelog(decodeChangelog(value), changes),
    research,
  );
  const usage = await ask(
    "usage",
    promptForDecoder(
      languagePrompt(USAGE, renderUsageInput(changes, changelog, snapshot), USAGE_TOOLS_NOTE),
      USAGE.schema,
    ),
    (value) => acceptUsages(decodeUsages(value)),
    research,
  );
  const facade = await ask(
    "facade",
    promptForDecoder(languagePrompt(FACADE, renderFacadeInput(usage, changelog)), FACADE.schema),
    (value) => acceptFacade(decodeFacade(value)),
  );
  const [body, lockfiles] = await Promise.all([
    ask(
      "pr_body",
      promptForDecoder(languagePrompt(PR_BODY, renderBodyInput(changes, changelog, usage, facade)), PR_BODY.schema),
      (value) => acceptBody(decodeBody(value), changes),
    ),
    settle(),
  ]);
  const { gates, verdict } = await driveLoop(deps, snapshot, url, changes, lockfiles);
  return finish({ url, kind, changes, changelog, usages: usage.usages, facade, body, gates, verdict });
}
