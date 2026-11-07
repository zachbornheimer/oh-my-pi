import type { StepContext } from "./context.js";
import { askJson, mapLimit } from "./omp_model.js";
import { PROPOSE, modelPrompt } from "./prompts.js";
import { proposalProblem } from "./proposal_checks.js";
import { arrayAt, leafAt, replyField } from "./reply.js";
import { sourceBrief } from "./source_brief.js";
import type { Leaf, Source } from "./types.js";

/** What a proposal is made from: the namespace it must keep to and the registered names under it it must not repeat. */
export interface ProposalFrame {
  readonly namespace?: string;
  readonly siblings: readonly string[];
  /** How many samples the source gets in all. */
  readonly samples: number;
}

/**
 * One sample: the leaves the source shows, whose names, evidence and count passed the deterministic checks (a reply
 * that fails one is asked again with the reason, as for any refused reply).
 */
export async function proposeLeaves(source: Source, frame: ProposalFrame, sample: number, ctx: StepContext): Promise<Leaf[]> {
  const prompt = modelPrompt(PROPOSE, sourceBrief(source, frame.namespace, frame.siblings));
  ctx.progress(`${source.ref}: proposing, sample ${sample + 1} of ${frame.samples}`);
  return askJson(ctx.step, prompt, (reply) => {
    const leaves = arrayAt(replyField(reply, PROPOSE.field), PROPOSE.field).map((value, index) =>
      leafAt(value, `${PROPOSE.field}[${index}]`)
    );
    const problem = proposalProblem(leaves, source, frame.namespace, frame.siblings);
    if (problem !== undefined) throw new Error(problem);
    return leaves;
  }, { signal: ctx.signal });
}

/** The source proposed `frame.samples` times at once. */
export function proposeSamples(source: Source, frame: ProposalFrame, ctx: StepContext): Promise<Leaf[][]> {
  return mapLimit(
    Array.from({ length: frame.samples }, (_, sample) => sample),
    frame.samples,
    (sample) => proposeLeaves(source, frame, sample, ctx),
  );
}
