import { homedir } from "node:os";
import { resolve } from "node:path";
import { applyPlan } from "./apply.js";
import { verificationChecks } from "./check_commands.js";
import type { Conventions } from "./conventions.js";
import type { DraftedSource } from "./draft_job.js";
import { draftJobOf, draftSources, draftTouchpoints, exportSignature, filesOf, reviseSources } from "./drafts.js";
import { readConventions } from "./gather/read_conventions.js";
import { repoRootOf } from "./gather/repo_files.js";
import { locateFiles } from "./locate.js";
import { type HostMachine, hostMachine } from "./machine.js";
import { modelOf } from "./model.js";
import type { Exec, ModelStep } from "./omp.js";
import { findingsToFix, reviewChange } from "./review.js";
import { type ImplementCodeRequest, type ImplementedCode, parseRequest } from "./schemas.js";

export interface ImplementCodeParams {
  design?: unknown;
  repo?: unknown;
  hints?: unknown;
  apply?: boolean | null;
}

export interface Deps {
  readonly exec: Exec;
  /** The directory the call was made from: the base of a relative repo, and the repo when none is named. */
  readonly cwd: string;
  readonly home?: string;
  /** One model call: `omp -p` in production, a fake in tests. */
  readonly model: ModelStep;
  readonly signal?: AbortSignal;
  /** Called at the start of every phase with its name. */
  readonly onPhase?: (name: string) => void;
  /** Substitutes for the real file system and processes, in tests. */
  readonly machine?: HostMachine;
}

/** Where `repo` lives: `~/` is the home directory, a relative path is from the working directory. */
export function repoPath(repo: string, cwd: string, home: string): string {
  if (repo === "~") return home;
  if (repo.startsWith("~/")) return resolve(home, repo.slice(2));
  return resolve(cwd, repo);
}

/**
 * Reads the repo's conventions, plans where the design's files go, drafts each file like its siblings, edits the
 * registries by insertion and reviews the result; with `apply`, then writes the files and runs the planned checks.
 */
export async function implementCode(params: ImplementCodeParams, deps: Deps): Promise<ImplementedCode> {
  const request: ImplementCodeRequest = parseRequest(params);
  const machine = deps.machine ?? hostMachine(deps.exec, deps.signal);
  const model = modelOf(deps.model, deps.signal);
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    deps.signal?.throwIfAborted();
    deps.onPhase?.(name);
    return work();
  };

  const repo = await step("read-repo", async () =>
    request.repo === undefined
      ? repoRootOf(machine, deps.cwd)
      : repoPath(request.repo, deps.cwd, deps.home ?? homedir())
  );
  const conventions: Conventions = await step("read-conventions", () =>
    readConventions(machine, repo, request.design, request.hints)
  );

  const plan = await step("locate", () => locateFiles(request.design, conventions, model));
  const job = draftJobOf(request.design, conventions, plan);
  let sources: DraftedSource[] = await step("draft", () => draftSources(job, model));
  let touchpoints = await step("touchpoints", () => draftTouchpoints(job, sources, model));
  const findings = await step(
    "review",
    () => reviewChange(request.design, conventions, filesOf(sources, touchpoints), model),
  );
  const toFix = findingsToFix(findings, filesOf(sources, touchpoints));
  if (toFix.size > 0) {
    const before = exportSignature(sources);
    sources = await step("revise", () => reviseSources(job, sources, toFix, model));
    if (exportSignature(sources) !== before) {
      touchpoints = await step("touchpoints_revised", () => draftTouchpoints(job, sources, model));
    }
  }
  const files = filesOf(sources, touchpoints);
  if (files.length === 0) throw new Error("implement_code: the plan has no files");
  const planned: ImplementedCode = {
    repo,
    files,
    touchpoints: touchpoints.map((touchpoint) => ({ path: touchpoint.path, diff: touchpoint.diff! })),
    callers_to_update: conventions.usages
      .map((usage) => ({ name: usage.name, files: usage.files.filter((file) => !job.changeSet.has(file)) }))
      .filter((usage) => usage.files.length > 0),
    checks: verificationChecks(conventions, plan),
    review: { findings, revised: toFix.size > 0 },
  };
  return params.apply === true ? step("apply", () => applyPlan(planned, machine)) : planned;
}
