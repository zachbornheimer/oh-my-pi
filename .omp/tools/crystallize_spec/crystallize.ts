import { join } from "node:path";
import { askJson, type ModelStep } from "./omp_model.js";
import { seedPrompt } from "./prompts.js";
import {
  type CrystallizeSpecInput,
  type CrystallizeSpecOutput,
  parseSeedReply,
  type Seed,
  type SeedMetadata,
} from "./schemas.js";
import { seedDigest, seedOf } from "./seed.js";
import { loadSession, type Session, sessionDirectory } from "./session.js";
import { checkoutOf, nextVersion, writeSpecFiles } from "./spec_files.js";
import { specMarkdown } from "./spec_markdown.js";

const REPO_SPECS_DIR = "specs";

export interface CrystallizeDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Why the interview may not be crystallized yet, worded so the caller knows what to do. */
export function gateRefusal(session: Session): string {
  const assessment = session.assessment;
  const why = assessment === undefined
    ? "it has not been graded yet (grading starts after 3 answered rounds)"
    : `ambiguity ${assessment.ambiguity.toFixed(2)} (needs <= 0.20)${
      assessment.floor_failures.length === 0 ? "" : `; floor failures: ${assessment.floor_failures.join("; ")}`
    }`;
  return `interview ${session.session_id} has not passed the ambiguity gate: ${why}. `
    + "Keep answering its questions, or pass force: true to write the spec anyway (recorded as gate_forced).";
}

function seedFile(seed: Seed, metadata: SeedMetadata): string {
  return `${JSON.stringify({ ...seed, metadata }, null, 2)}\n`;
}

/**
 * Turns a finished interview into an immutable spec: one model call writes the seed, then `seed.json` and a
 * Spec-Kit-shaped `spec.md` go to the central store (and to `<repo>/specs/<session_id>/` when a repo is named).
 */
export async function runCrystallize(input: CrystallizeSpecInput, deps: CrystallizeDeps): Promise<CrystallizeSpecOutput> {
  if (typeof input.session_id !== "string" || input.session_id.trim() === "") {
    throw new Error("session_id must not be empty");
  }
  const session = await loadSession(input.session_id.trim());
  const checkout = input.repo === undefined ? undefined : await checkoutOf(input.repo);
  const ready = session.status === "ready";
  if (!ready && input.force !== true) throw new Error(gateRefusal(session));

  const seed = await askJson(deps.step, seedPrompt(session), (value) => seedOf(parseSeedReply(value)), {
    signal: deps.signal,
  });
  deps.signal?.throwIfAborted();

  const store = sessionDirectory(session.session_id);
  const repoDirectory = checkout === undefined ? undefined : join(checkout, REPO_SPECS_DIR, session.session_id);
  const version = await nextVersion(...(repoDirectory === undefined ? [store] : [store, repoDirectory]));
  const metadata: SeedMetadata = {
    ambiguity: session.assessment?.ambiguity ?? null,
    breakdown: session.assessment?.breakdown ?? {},
    gate_forced: !ready,
    interview_session_id: session.session_id,
    version,
    created_at: (deps.now?.() ?? new Date()).toISOString(),
    sha256: seedDigest(seed),
  };
  const files = { seed: seedFile(seed, metadata), spec: specMarkdown(seed, metadata, session) };
  const central = await writeSpecFiles(store, version, files);
  const copy = repoDirectory === undefined ? undefined : await writeSpecFiles(repoDirectory, version, files);
  return {
    session_id: session.session_id,
    spec_path: central.specPath,
    seed_path: central.seedPath,
    ...(copy === undefined ? {} : { repo_spec_path: copy.specPath }),
    ambiguity: metadata.ambiguity,
    gate_forced: metadata.gate_forced,
  };
}
