import { nameProblem } from "./capability_name.js";
import type { AgreedLeaf } from "./consensus.js";
import type { StepContext } from "./context.js";
import { askJson, mapLimit } from "./omp_model.js";
import { CONFIRM, modelPrompt, REGISTERED } from "./prompts.js";
import type { ProposalFrame } from "./propose_leaves.js";
import { arrayAt, booleanAt, recordAt, replyField, stringAt } from "./reply.js";
import { registeredText } from "./source_brief.js";
import type { Leaf, Rejected, Source } from "./types.js";

/** The criteria the confirming model judges a leaf by. */
export const CRITERIA = ["distinct", "useful", "irreducible", "complete", "clear", "concise"] as const;
export type Criterion = (typeof CRITERIA)[number];
export const MAX_OBJECTION_CHARS = 200;
const REGISTERED_CONCURRENCY = 6;
/** What the registered-distinct gate says when it removes a leaf; there is no probability to show. */
export const NOT_DISTINCT_OBJECTION = "too close to a registered capability (the model judged it not distinct)";

export interface Verdict {
  readonly name: string;
  readonly pass: boolean;
  readonly failed_criteria: readonly Criterion[];
  readonly objection: string;
  /** A better name for a leaf that passes; empty or absent to keep its name. */
  readonly rename_to?: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function verdictAt(value: unknown, path: string): Verdict {
  const verdict = recordAt(value, path);
  const criteria = arrayAt(verdict.failed_criteria, `${path}.failed_criteria`).map((criterion, index) => {
    if (typeof criterion !== "string" || !(CRITERIA as readonly string[]).includes(criterion)) {
      throw new Error(`${path}.failed_criteria[${index}] must be one of ${CRITERIA.join(", ")}`);
    }
    return criterion as Criterion;
  });
  const rename = verdict.rename_to;
  if (rename !== undefined && rename !== null && typeof rename !== "string") {
    throw new Error(`${path}.rename_to must be a string, got ${JSON.stringify(rename)}`);
  }
  return {
    name: stringAt(verdict.name, `${path}.name`),
    pass: booleanAt(verdict.pass, `${path}.pass`),
    failed_criteria: criteria,
    objection: stringAt(verdict.objection, `${path}.objection`),
    ...(typeof rename === "string" ? { rename_to: rename } : {}),
  };
}

/** Why the verdicts cannot stand for `leaves`, written for the model; undefined when each leaf has one consistent verdict. */
export function verdictsProblem(verdicts: readonly Verdict[], leaves: readonly Leaf[]): string | undefined {
  const asked = new Set(leaves.map((leaf) => leaf.name));
  const answered = new Set<string>();
  for (const verdict of verdicts) {
    if (!asked.has(verdict.name)) return `"${verdict.name}" is not a proposed capability: use the names as written`;
    if (answered.has(verdict.name)) return `"${verdict.name}" has two verdicts: give each capability one`;
    answered.add(verdict.name);
    const failed = verdict.failed_criteria.length > 0;
    if (verdict.pass && failed) {
      return `"${verdict.name}" passes but lists failed criteria: pass is false when any fails`;
    }
    if (!verdict.pass && !failed) return `"${verdict.name}" fails: list the criteria it fails`;
    if (!verdict.pass && oneLine(verdict.objection) === "") {
      return `"${verdict.name}" fails: say what is wrong in objection`;
    }
    if (oneLine(verdict.objection).length > MAX_OBJECTION_CHARS) {
      return `the objection for "${verdict.name}" is over ${MAX_OBJECTION_CHARS} characters: say it in one short line`;
    }
  }
  const missing = leaves.find((leaf) => !answered.has(leaf.name));
  return missing === undefined ? undefined : `no verdict for "${missing.name}": answer for every capability`;
}

const leafText = (leaf: Leaf): string =>
  [
    `Capability: ${leaf.name}`,
    `Purpose: ${leaf.purpose}`,
    `Reason: ${leaf.reason}`,
    `Input: ${leaf.input_summary}`,
    `Output: ${leaf.output_summary}`,
  ].join("\n");

function verdictInput(leaves: readonly Leaf[], source: Source, siblings: readonly string[]): string {
  return [
    `Source: ${source.ref} (${source.kind})`,
    ...(siblings.length === 0 ? [] : [registeredText(siblings)]),
    "Proposed capabilities:",
    leaves.map(leafText).join("\n\n"),
  ].join("\n");
}

/** One model call: a verdict for every leaf against the six criteria, each failure with its objection. */
export async function judgeLeaves(
  leaves: readonly Leaf[],
  source: Source,
  siblings: readonly string[],
  ctx: StepContext,
): Promise<Verdict[]> {
  ctx.progress(`${source.ref}: judging ${leaves.length} capabilities against six criteria`);
  const prompt = modelPrompt(CONFIRM, verdictInput(leaves, source, siblings));
  return askJson(ctx.step, prompt, (reply) => {
    const verdicts = arrayAt(replyField(reply, CONFIRM.field), CONFIRM.field).map((value, index) =>
      verdictAt(value, `${CONFIRM.field}[${index}]`)
    );
    const problem = verdictsProblem(verdicts, leaves);
    if (problem !== undefined) throw new Error(problem);
    return verdicts;
  }, { signal: ctx.signal });
}

/** One model call: does the leaf do something none of the registered capabilities does? The model states yes or no. */
async function distinctFromRegistered(
  leaf: Leaf,
  siblings: readonly string[],
  source: Source,
  ctx: StepContext,
): Promise<boolean> {
  ctx.progress(`${source.ref}: ${leaf.name} against the registered capabilities`);
  const prompt = modelPrompt(
    REGISTERED,
    ["Answer about this segment only:", leafText(leaf), "The whole input, for context only (do not answer about other segments):", registeredText(siblings)].join("\n"),
  );
  return askJson(ctx.step, prompt, (reply) => booleanAt(replyField(reply, REGISTERED.field), REGISTERED.field), {
    signal: ctx.signal,
  });
}

export interface Confirmation<L extends AgreedLeaf> {
  readonly kept: L[];
  readonly rejected: Rejected[];
  /** The model calls it took. */
  readonly calls: number;
}

/** The criteria that judge a name; a leaf that fails only these is a good capability with a bad name. */
export const NAME_CRITERIA: ReadonlySet<string> = new Set(["irreducible", "complete", "clear", "concise"]);

const failsOnlyOnName = (verdict: Verdict): boolean =>
  !verdict.pass && verdict.failed_criteria.every((criterion) => NAME_CRITERIA.has(criterion));

/**
 * The leaves the verdicts let through, each with the better name its verdict gave when that name passes the lint, is
 * not a registered or another kept name, and is not the leaf's own. A leaf that passes keeps its name when the better
 * one is refused; a leaf that fails only on its name is let through only under a better name, which is applied once
 * with the old name recorded as `renamed_from`. A leaf that fails on anything else is not let through.
 */
function accepted<L extends AgreedLeaf>(
  leaves: readonly L[],
  verdicts: ReadonlyMap<string, Verdict>,
  frame: ProposalFrame,
): L[] {
  const taken = new Set([...leaves.map((leaf) => leaf.name), ...frame.siblings]);
  return leaves.flatMap((leaf) => {
    const verdict = verdicts.get(leaf.name)!;
    if (!verdict.pass && !failsOnlyOnName(verdict)) return [];
    const wanted = verdict.rename_to?.trim() ?? "";
    const usable = wanted !== "" && wanted !== leaf.name && !taken.has(wanted)
      && nameProblem(wanted, frame.namespace) === undefined;
    if (!usable) return verdict.pass ? [leaf] : [];
    taken.add(wanted);
    return [{ ...leaf, name: wanted, renamed_from: leaf.name }];
  });
}

/**
 * Keeps the leaves that pass the model's six criteria and, when capabilities are registered under the namespace, the
 * model's yes/no check that they differ from every one of them. A rejection carries the model's one-line objection; a
 * passing leaf may carry a better name.
 */
export async function confirmLeaves<L extends AgreedLeaf>(
  leaves: readonly L[],
  source: Source,
  frame: ProposalFrame,
  ctx: StepContext,
): Promise<Confirmation<L>> {
  if (leaves.length === 0) return { kept: [], rejected: [], calls: 0 };
  const { siblings } = frame;
  const verdicts = new Map(
    (await judgeLeaves(leaves, source, siblings, ctx)).map((verdict) => [verdict.name, verdict]),
  );
  const passing = accepted(leaves, verdicts, frame);
  const letThrough = new Set(passing.map((leaf) => leaf.renamed_from ?? leaf.name));
  const rejected: Rejected[] = leaves.filter((leaf) => !letThrough.has(leaf.name)).map((leaf) => {
    const verdict = verdicts.get(leaf.name)!;
    return {
      name: leaf.name,
      objection: oneLine(verdict.objection),
      failed_criteria: verdict.failed_criteria,
      agreement: leaf.agreement,
      members: leaf.members,
    };
  });
  if (siblings.length === 0) return { kept: passing, rejected, calls: 1 };
  const distinct = await mapLimit(
    passing,
    REGISTERED_CONCURRENCY,
    (leaf) => distinctFromRegistered(leaf, siblings, source, ctx),
  );
  const kept: L[] = [];
  passing.forEach((leaf, index) => {
    if (distinct[index]) kept.push(leaf);
    else {
      rejected.push({
        name: leaf.name,
        objection: NOT_DISTINCT_OBJECTION,
        failed_criteria: ["distinct"],
        agreement: leaf.agreement,
        members: leaf.members,
      });
    }
  });
  return { kept, rejected, calls: 1 + passing.length };
}
