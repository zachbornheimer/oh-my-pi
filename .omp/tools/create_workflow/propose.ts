import type { ProposeDeps, StepContext } from "./context.js";
import { resolveSources } from "./gather.js";
import { listCapabilities } from "./list_capabilities.js";
import { limitStep, mapLimit } from "./omp_model.js";
import { registeredSiblings } from "./proposal_checks.js";
import { writePseudocode } from "./pseudocode.js";
import { registeredFor } from "./registered.js";
import { conversationReaderFor } from "./transcript.js";
import {
  type CallCounts,
  DEFAULT_MIN_AGREEMENT,
  DEFAULT_SAMPLES,
  MAX_SAMPLES,
  MIN_SAMPLES,
  NAMESPACE,
  type Phase,
  type ProposeCapabilitiesInput,
  type ProposeCapabilitiesOutput,
  type Source,
  type SourceRun,
} from "./types.js";

export const SOURCE_CONCURRENCY = 4;
export const PSEUDOCODE_CONCURRENCY = 6;

const sumOf = (runs: readonly SourceRun[], count: (run: SourceRun) => number): number =>
  runs.reduce((total, run) => total + count(run), 0);

const totalCalls = (runs: readonly SourceRun[]): CallCounts => ({
  propose: sumOf(runs, (run) => run.usage.calls.propose),
  reconcile: sumOf(runs, (run) => run.usage.calls.reconcile),
  confirm: sumOf(runs, (run) => run.usage.calls.confirm),
  pseudocode: sumOf(runs, (run) => run.usage.calls.pseudocode),
});

/** The input with its defaults, or the first refusal. */
export interface Options {
  readonly sources: readonly (string | Source)[];
  readonly namespace?: string;
  readonly phase: Phase;
  readonly samples: number;
  readonly minAgreement: number;
  readonly registered?: readonly string[];
}

const whole = (value: unknown, low: number, high: number, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new Error(`propose_capabilities: ${name} must be a whole number from ${low} to ${high}, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** Checks the input and fills its defaults (`null` counts as omitted); throws naming the field that is wrong. */
export function optionsFrom(input: ProposeCapabilitiesInput): Options {
  const sources = (input as { sources?: unknown }).sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "propose_capabilities: sources must name at least one conversation ref, file or folder, such as claude:<id> or ~/Developer/Personal/zq",
    );
  }
  const namespace = input.namespace ?? undefined;
  if (namespace !== undefined && (typeof namespace !== "string" || !NAMESPACE.test(namespace))) {
    throw new Error('propose_capabilities: namespace must be one lower-case word such as "webmaster"');
  }
  const phase = input.phase ?? 2;
  if (phase !== 1 && phase !== 2) throw new Error(`propose_capabilities: phase must be 1 or 2, got ${JSON.stringify(phase)}`);
  const registered = input.registered ?? undefined;
  if (registered !== undefined && (!Array.isArray(registered) || registered.some((name) => typeof name !== "string"))) {
    throw new Error("propose_capabilities: registered must be an array of names");
  }
  return {
    sources,
    ...(namespace === undefined ? {} : { namespace }),
    phase,
    samples: input.samples === undefined || input.samples === null ? DEFAULT_SAMPLES : whole(input.samples, MIN_SAMPLES, MAX_SAMPLES, "samples"),
    minAgreement: input.min_agreement === undefined || input.min_agreement === null
      ? DEFAULT_MIN_AGREEMENT
      : whole(input.min_agreement, MIN_SAMPLES, MAX_SAMPLES, "min_agreement"),
    ...(registered === undefined ? {} : { registered }),
  };
}

/**
 * Reads each source, then proposes its distinct leaf capabilities: `samples` independent proposals, one call that groups
 * them by concept, agreement, a confirming judgement of six criteria and (phase 2) pseudocode for each kept leaf. It
 * proposes and builds nothing; it only reads the sources and asks the model. Sources run 4 at a time; at most
 * `MAX_MODEL_PROCESSES` model calls run at once. The first failure aborts the run and the model calls still in flight.
 */
export async function runProposeCapabilities(
  input: ProposeCapabilitiesInput,
  deps: ProposeDeps,
): Promise<ProposeCapabilitiesOutput> {
  const options = optionsFrom(input);
  const controller = new AbortController();
  const outer = deps.signal;
  const forward = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  outer?.addEventListener("abort", forward, { once: true });
  try {
    const signal = controller.signal;
    const ctx: StepContext = {
      step: limitStep(deps.step),
      signal,
      progress: deps.onProgress ?? (() => {}),
    };
    const sources = await resolveSources(options.sources, {
      machine: deps.machine,
      readConversation: deps.readConversation ?? conversationReaderFor(deps.machine.homeDirectory),
      signal,
    });
    const registered = await registeredFor(options.registered, options.namespace, deps.machine);
    const siblings = registeredSiblings(registered, options.namespace);
    const runs = await mapLimit(sources, SOURCE_CONCURRENCY, async (source): Promise<SourceRun> => {
      const listed = await listCapabilities(source, {
        namespace: options.namespace,
        samples: options.samples,
        minAgreement: options.minAgreement,
        siblings,
      }, ctx);
      const pseudocode = options.phase === 1
        ? []
        : await mapLimit(listed.kept, PSEUDOCODE_CONCURRENCY, (leaf) => writePseudocode(leaf, source, ctx));
      return {
        source: source.ref,
        kind: source.kind,
        samples: options.samples,
        capabilities: listed.kept.map((leaf, index) => ({
          ...leaf,
          ...(pseudocode[index] === undefined ? {} : { pseudocode: pseudocode[index] }),
        })),
        merged: listed.merged,
        rejected: listed.rejected,
        usage: { calls: { ...listed.calls, pseudocode: pseudocode.length } },
      };
    });
    return {
      runs,
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      registered: siblings,
      totals: {
        sources: runs.length,
        kept: sumOf(runs, (run) => run.capabilities.length),
        merged: sumOf(runs, (run) => run.merged.length),
        rejected: sumOf(runs, (run) => run.rejected.length),
        calls: totalCalls(runs),
      },
    };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    outer?.removeEventListener("abort", forward);
  }
}
