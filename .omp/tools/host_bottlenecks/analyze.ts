import { type FamilyDraft, familyDrafts } from "./families.ts";
import type { ModelStep } from "./omp_model.ts";
import { summaryOf, weightOf } from "./summary.ts";
import type { Family, HostBottlenecksOutput, HostSnapshot, ModelVerdict } from "./types.ts";
import { askVerdicts } from "./unknown_verdicts.ts";
import { type HostContext, type Judgement, describeFamily, hostContext, judge } from "./verdict_rules.ts";

export interface AnalyzeOptions {
  readonly top: number;
  readonly include_normal: boolean;
}

/** The `top` heaviest families by CPU together with the `top` heaviest by memory. */
function heaviest(drafts: readonly FamilyDraft[], top: number): FamilyDraft[] {
  const by = (field: "cpu_pct" | "rss_mb") => [...drafts].sort((a, b) => b[field] - a[field]).slice(0, top);
  return [...new Set([...by("cpu_pct"), ...by("rss_mb")])];
}

function describedFamily(draft: FamilyDraft): Omit<Family, "verdict" | "confidence" | "evidence"> {
  const { worker: _worker, sameBaseMax: _same, ancestryKinds: _kinds, hook_config: _config, ...family } = draft;
  return family;
}

const fromRules = (draft: FamilyDraft, judgement: Judgement): Family => ({
  ...describedFamily(draft),
  verdict: judgement.verdict,
  confidence: judgement.confidence,
  evidence: [...judgement.evidence],
  remedy: judgement.remedy,
  advice: judgement.advice,
});

function fromModel(draft: FamilyDraft, answer: ModelVerdict | undefined): Family {
  const evidence = [describeFamily(draft)];
  if (answer === undefined) {
    return {
      ...describedFamily(draft),
      verdict: "unknown",
      confidence: 0,
      evidence: [...evidence, "no rule matched and the model gave no verdict"],
    };
  }
  return {
    ...describedFamily(draft),
    verdict: answer.verdict,
    confidence: answer.confidence,
    evidence: [...evidence, `no rule matched; the model judged it ${answer.verdict}`],
    remedy: answer.remedy,
    advice: answer.advice,
  };
}

async function judgedFamilies(
  drafts: readonly FamilyDraft[],
  host: HostContext,
  snapshot: HostSnapshot,
  step: ModelStep,
  signal: AbortSignal | undefined,
): Promise<Family[]> {
  const judgements = drafts.map((draft) => ({ draft, judgement: judge(draft, host) }));
  const unsettled = judgements
    .filter(({ judgement }) => judgement === undefined)
    .map(({ draft }) => ({ family: draft, evidence: describeFamily(draft) }));
  const answers = await askVerdicts(
    unsettled,
    {
      loadRatio: host.loadRatio,
      ncpu: snapshot.ncpu,
      extras: { swap: snapshot.swap, disks: snapshot.disks, vms: snapshot.vms },
    },
    step,
    signal,
  );
  return judgements.map(({ draft, judgement }) =>
    judgement === undefined ? fromModel(draft, answers.get(draft.root_pid)) : fromRules(draft, judgement),
  );
}

const heavierFirst = (a: Family, b: Family): number => weightOf(b) - weightOf(a);

/**
 * The heaviest CPU and memory process families in one snapshot, each with what started it, a verdict and a remedy. The
 * rules settle what they can; one model call judges the rest. Touches no machine: the snapshot is its whole input.
 */
export async function analyzeHost(
  snapshot: HostSnapshot,
  options: AnalyzeOptions,
  step: ModelStep,
  signal?: AbortSignal,
): Promise<HostBottlenecksOutput> {
  const drafts = familyDrafts(snapshot);
  const host = hostContext(snapshot, drafts);
  const judged = (await judgedFamilies(heaviest(drafts, options.top), host, snapshot, step, signal)).sort(heavierFirst);
  const normal = judged.filter((family) => family.verdict === "normal");
  const families = judged.filter((family) => options.include_normal || family.verdict !== "normal");
  const load = {
    avg1: snapshot.load.avg1,
    avg5: snapshot.load.avg5,
    avg15: snapshot.load.avg15,
    ncpu: snapshot.ncpu,
    ratio: Number(host.loadRatio.toFixed(2)),
    memory_pressure: snapshot.memory_pressure,
  };
  return {
    taken_at: snapshot.taken_at,
    load,
    families,
    normal,
    ...(snapshot.swap === undefined ? {} : { swap: snapshot.swap }),
    disks: [...snapshot.disks],
    vms: [...snapshot.vms],
    summary: summaryOf(load, families[0] ?? normal[0], snapshot),
  };
}
