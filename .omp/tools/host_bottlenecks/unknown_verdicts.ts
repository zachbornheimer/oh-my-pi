import type { FamilyDraft } from "./families.ts";
import { type ModelStep, askJson } from "./omp_model.ts";
import { sizeText } from "./summary.ts";
import { type Disk, type ModelVerdict, REMEDIES, type Remedy, type Swap, VERDICTS, type Verdict, type Vm } from "./types.ts";
import { verdictPrompt } from "./verdict_prompt.ts";

const SECONDS_PER_HOUR = 3600;

const ageText = (seconds: number): string => `${Math.round(seconds / SECONDS_PER_HOUR)} h`;

function describe(family: FamilyDraft, evidence: string): string {
  const started = family.trigger ?? "none";
  const place = family.repo === undefined ? "" : `, repo=${family.repo}`;
  return `Family root_pid ${family.root_pid}: name=${family.name}, kind=${family.kind}, cpu=${family.cpu_pct}%, `
    + `rss=${family.rss_mb} MB, ${family.count} process(es), age=${ageText(family.age_s)}, started by: ${started}`
    + `, ancestry: ${family.ancestry.join(" < ") || "none"}${place}\n  evidence: ${evidence}`;
}

/** What the model reads about the host beyond its load, so it can judge VMs, swap and full disks. */
export interface HostExtras {
  readonly swap?: Swap;
  readonly disks: readonly Disk[];
  readonly vms: readonly Vm[];
}

const FULL_DISK_PCT = 90;
const MIB_PER_GB = 1024;

/** The host lines beyond the load: swap in use, disks close to full, and what each VM runs inside. */
export function hostLines(extras: HostExtras): string[] {
  const lines: string[] = [];
  if (extras.swap !== undefined && extras.swap.used_mb > 0) {
    lines.push(`Swap ${sizeText(extras.swap.used_mb / MIB_PER_GB)} of ${sizeText(extras.swap.total_mb / MIB_PER_GB)} used.`);
  }
  for (const disk of extras.disks.filter((disk) => disk.capacity_pct >= FULL_DISK_PCT)) {
    lines.push(
      `Disk ${disk.mount} is ${disk.capacity_pct}% full (${sizeText(disk.free_gb)} free of ${sizeText(disk.size_gb)}).`,
    );
  }
  for (const vm of extras.vms) {
    const containers = vm.containers === undefined
      ? []
      : vm.containers.map((container) => `${container.name} ${container.cpu_pct}% (${container.mem_mb} MB)`);
    const caps = vm.caps === undefined ? "" : `${vm.caps.cpus} cpus, ${vm.caps.memory_mb} MB, `;
    const inside = containers.length === 0 ? "containers not visible" : `containers: ${containers.join(", ")}`;
    lines.push(`VM pid ${vm.pid} ${vm.product} (image ${vm.image}): ${caps}${inside}.`);
  }
  return lines;
}

/** What the model reads: the host's load and each unsettled family with its evidence. */
export function verdictBrief(
  families: ReadonlyArray<{ readonly family: FamilyDraft; readonly evidence: string }>,
  loadRatio: number,
  ncpu: number,
  extras: HostExtras = { disks: [], vms: [] },
): string {
  const lines = families.map(({ family, evidence }) => describe(family, evidence));
  return [
    `Host: load ${loadRatio.toFixed(1)} per core (${ncpu} cores).`,
    ...hostLines(extras).map((line) => `Host: ${line}`),
    ...lines,
  ].join("\n");
}

/** Checks one reply entry against the closed lists and the listed pids; throws the reason, which is shown to the model on retry. */
function validEntry(entry: unknown, listed: ReadonlySet<number>): ModelVerdict {
  if (typeof entry !== "object" || entry === null) throw new Error("each Verdicts entry must be an object");
  const { root_pid, verdict, remedy, advice, confidence } = entry as Record<string, unknown>;
  if (typeof root_pid !== "number" || !Number.isInteger(root_pid)) throw new Error("root_pid must be an integer");
  if (!listed.has(root_pid)) {
    throw new Error(`root_pid ${root_pid} is not one of the families listed: ${[...listed].join(", ")}`);
  }
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`verdict ${JSON.stringify(verdict)} is not one of ${VERDICTS.join(", ")}`);
  }
  if (typeof remedy !== "string" || !(REMEDIES as readonly string[]).includes(remedy)) {
    throw new Error(`remedy ${JSON.stringify(remedy)} is not one of ${REMEDIES.join(", ")}`);
  }
  if (typeof advice !== "string") throw new Error("advice must be a string");
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  return { root_pid, verdict: verdict as Verdict, remedy: remedy as Remedy, advice, confidence };
}

/** The reply's `Verdicts` array, every entry valid; throws the first reason a reply is not acceptable. */
export function validReply(reply: unknown, listed: ReadonlySet<number>): ModelVerdict[] {
  const verdicts = (reply as { Verdicts?: unknown } | null)?.Verdicts;
  if (!Array.isArray(verdicts)) throw new Error("the reply must be an object with a Verdicts array");
  return verdicts.map((entry) => validEntry(entry, listed));
}

/** The model's verdict for each family the rules left unknown, keyed by root pid. One model call; none when nothing is unknown. */
export async function askVerdicts(
  families: ReadonlyArray<{ readonly family: FamilyDraft; readonly evidence: string }>,
  host: { readonly loadRatio: number; readonly ncpu: number; readonly extras: HostExtras },
  step: ModelStep,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, ModelVerdict>> {
  if (families.length === 0) return new Map();
  const listed = new Set(families.map(({ family }) => family.root_pid));
  const prompt = verdictPrompt(verdictBrief(families, host.loadRatio, host.ncpu, host.extras));
  const verdicts = await askJson(step, prompt, (reply) => validReply(reply, listed), { signal });
  return new Map(verdicts.map((verdict) => [verdict.root_pid, verdict]));
}
