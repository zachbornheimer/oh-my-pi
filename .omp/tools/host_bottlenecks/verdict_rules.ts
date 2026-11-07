import type { FamilyDraft } from "./families.ts";
import { invocationOf } from "./process_command.ts";
import type { HostSnapshot, ProcessKind, Remedy, Verdict, Vm } from "./types.ts";

/** A verdict the rules settled, with the lines that justify it. */
export interface Judgement {
  readonly verdict: Verdict;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly remedy: Remedy;
  readonly advice: string;
}

/** What the rules know about the whole host, beyond one family. */
export interface HostContext {
  readonly loadRatio: number;
  readonly uptime_s?: number;
  /** The roots of the gate, test and build families alive while the host is oversubscribed; empty otherwise. */
  readonly contenders: ReadonlySet<number>;
  /** Model server families doing real work; an idle one costs nothing but its memory. */
  readonly busyModelServers: number;
  /** What each VM in the snapshot runs inside it, keyed by the VM process's pid. */
  readonly vms: ReadonlyMap<number, Vm>;
}

export const RULE_CONFIDENCE = 0.9;
/** An indexer is expected to be busy this long after boot. */
export const INDEXER_GRACE_S = 3600;
export const HARNESS_NORMAL_CPU_PCT = 100;
export const HARNESS_NORMAL_COUNT = 20;
export const SYNC_NORMAL_CPU_PCT = 30;
export const MAX_SAME_BASE_MEMBERS = 40;
export const MAX_FAN_OUT_MEMBERS = 20;
export const STALE_AGE_S = 6 * 3600;
/** avg1 per core above which the host is oversubscribed. */
export const CONTENTION_LOAD_RATIO = 2;
export const MIN_CONTENDERS = 2;
/** A model server under this CPU percent is idle, however many there are. */
export const MODEL_SERVER_IDLE_CPU_PCT = 5;
const MAX_ADVISED_PIDS = 100;
const COMMAND_LENGTH = 80;
const SECONDS_PER_HOUR = 3600;

const WORK_KINDS: readonly ProcessKind[] = ["gate", "test", "build"];
const SCOPED_KINDS: readonly ProcessKind[] = ["gate", "test"];
const HUMAN_ANCESTRY: readonly ProcessKind[] = ["harness", "shell"];
const PUSH_PHASE = "pre-push";
const COMMIT_TRIGGER = "git commit";

type Rule = (family: FamilyDraft, host: HostContext) => Judgement | undefined;

const isWork = (family: FamilyDraft): boolean => WORK_KINDS.includes(family.kind);
const isScoped = (family: FamilyDraft): boolean => SCOPED_KINDS.includes(family.kind);
const hours = (seconds: number): string => `${Math.round(seconds / SECONDS_PER_HOUR)} h`;
const pidList = (family: FamilyDraft): string => family.pids.slice(0, MAX_ADVISED_PIDS).join(" ");

/** The line every family carries: which process, what started it, where, and how wide it is. */
export function describeFamily(family: FamilyDraft): string {
  const { worker, trigger, hook_phase, repo, scope } = family;
  const origin = trigger === undefined ? "" : ` under ${trigger}${hook_phase === undefined ? "" : ` (${hook_phase})`}`;
  const place = repo === undefined ? "" : ` in ${repo}`;
  const reach = scope?.whole_tree === true
    ? "whole tree"
    : scope?.invoked_files !== undefined
    ? `${scope.invoked_files} file(s) given`
    : `${family.count} process(es), ${family.cpu_pct}% cpu, ${family.rss_mb} MB`;
  return `pid ${worker.pid} ${worker.command.slice(0, COMMAND_LENGTH)}${origin}${place}: ${reach}`;
}

function judged(
  verdict: Verdict,
  family: FamilyDraft,
  reason: string,
  remedy: Remedy,
  advice: string,
): Judgement {
  return { verdict, confidence: RULE_CONFIDENCE, evidence: [describeFamily(family), reason], remedy, advice };
}

const expected = (family: FamilyDraft, reason: string): Judgement =>
  judged("normal", family, reason, "none", `Expected load for a ${family.kind.replace("_", " ")}; nothing to change.`);

const normalReason = (family: FamilyDraft, host: HostContext): string | undefined => {
  switch (family.kind) {
    case "model_server":
      return family.cpu_pct < MODEL_SERVER_IDLE_CPU_PCT || host.busyModelServers < MIN_CONTENDERS
        ? "a model server holds its model in memory"
        : undefined;
    case "system":
      return "a system process";
    case "indexer":
      return host.uptime_s !== undefined && host.uptime_s < INDEXER_GRACE_S
        ? "indexing is expected soon after boot"
        : undefined;
    case "harness":
      return family.cpu_pct < HARNESS_NORMAL_CPU_PCT && family.count < HARNESS_NORMAL_COUNT
        ? "one agent session at a normal size"
        : undefined;
    case "sync":
      return family.cpu_pct < SYNC_NORMAL_CPU_PCT ? "a sync client at a normal load" : undefined;
    default:
      return undefined;
  }
};

const normalRule: Rule = (family, host) => {
  const reason = normalReason(family, host);
  return reason === undefined ? undefined : expected(family, reason);
};

function fanOutReason(family: FamilyDraft): string | undefined {
  if (family.sameBaseMax > MAX_SAME_BASE_MEMBERS) {
    return `${family.sameBaseMax} members share one command under one root (limit ${MAX_SAME_BASE_MEMBERS})`;
  }
  const fansOut = family.kind === "vm" || family.kind === "mcp";
  return fansOut && family.count > MAX_FAN_OUT_MEMBERS
    ? `${family.count} members under one ${family.kind} root (limit ${MAX_FAN_OUT_MEMBERS})`
    : undefined;
}

const abandoned = (family: FamilyDraft): boolean =>
  isWork(family) && family.age_s > STALE_AGE_S && !family.ancestryKinds.some((kind) => HUMAN_ANCESTRY.includes(kind));

const runawayRule: Rule = (family) => {
  const fanOut = fanOutReason(family);
  if (fanOut !== undefined) {
    return judged(
      "runaway",
      family,
      fanOut,
      "cap_fan_out",
      `Cap how many ${family.name} processes run at once; to stop them now: kill ${pidList(family)}`,
    );
  }
  if (!abandoned(family)) return undefined;
  return judged(
    "runaway",
    family,
    `running ${hours(family.age_s)} with no agent or shell above it`,
    "kill_stale",
    `${family.name} has run ${hours(family.age_s)} with nothing driving it; if it is stale: kill ${pidList(family)}`,
  );
};

function scopeAdvice(family: FamilyDraft): string {
  const where = family.repo === undefined ? "the hook" : `the hook of ${family.repo}`;
  const config = family.hook_config === undefined ? "" : `; edit ${family.hook_config}`;
  return `Run ${invocationOf(family.worker.command).base} on the changed files only in ${where}${config}`;
}

function overscopedReason(family: FamilyDraft): string | undefined {
  const fromGit = family.trigger?.startsWith("git ") === true;
  if (isScoped(family) && family.scope?.whole_tree === true && (fromGit || family.hook_phase !== undefined)) {
    return `a whole-tree ${family.kind} run by ${family.trigger ?? family.hook_phase}`;
  }
  const pushOnCommit = family.kind === "gate" && family.hook_phase === PUSH_PHASE && family.trigger === COMMIT_TRIGGER;
  return pushOnCommit ? "push hooks run on a commit" : undefined;
}

const overscopedRule: Rule = (family) => {
  const reason = overscopedReason(family);
  return reason === undefined
    ? undefined
    : judged("overscoped", family, reason, "scope_hook_to_changed_files", scopeAdvice(family));
};

/** The share of a VM's own CPUs the advice caps its heaviest container at. */
const ADVISED_VM_CAP_FRACTION = 0.5;

/** The cores a VM's containers demand together and the heaviest one, when the gatherer saw inside the VM. */
function containerDemand(vm: Vm): { readonly cores: number; readonly worstName: string; readonly worstPct: number } {
  if (vm.caps === undefined || vm.containers === undefined || vm.containers.length === 0) {
    return { cores: 0, worstName: "", worstPct: 0 };
  }
  const pct = vm.containers.reduce((total, container) => total + container.cpu_pct, 0);
  const worst = vm.containers[0]!;
  return { cores: Math.round((pct / 100) * 10) / 10, worstName: worst.name, worstPct: worst.cpu_pct };
}

const vmOversubscriptionRule: Rule = (family, host) => {
  if (family.kind !== "vm") return undefined;
  const vm = host.vms.get(family.root_pid);
  if (vm?.caps === undefined) return undefined;
  const demand = containerDemand(vm);
  if (demand.cores <= vm.caps.cpus) return undefined;
  const cap = Math.max(1, Math.floor(vm.caps.cpus * ADVISED_VM_CAP_FRACTION));
  return judged(
    "contention",
    family,
    `the containers inside the ${vm.product} VM demand ${demand.cores} cores of its ${vm.caps.cpus} `
      + `(${demand.worstName} alone ${demand.worstPct}%)`,
    "cap_fan_out",
    `Cap the heaviest container: \`docker update --cpus ${cap} ${demand.worstName}\` holds until the container is recreated.`,
  );
};

const contentionRule: Rule = (family, host) => {
  const busyModelServer = family.kind === "model_server" && family.cpu_pct >= MODEL_SERVER_IDLE_CPU_PCT;
  if (busyModelServer && host.busyModelServers >= MIN_CONTENDERS) {
    return judged(
      "contention",
      family,
      `${host.busyModelServers} busy model servers compete`,
      "serialize_gates",
      "Run one model server at a time.",
    );
  }
  if (!host.contenders.has(family.root_pid)) return undefined;
  return judged(
    "contention",
    family,
    `load is ${host.loadRatio.toFixed(1)} per core with ${host.contenders.size} gate, test or build jobs alive`,
    "serialize_gates",
    `Run the ${host.contenders.size} gate, test and build jobs one at a time instead of together.`,
  );
};

const RULES: readonly Rule[] = [normalRule, runawayRule, overscopedRule, vmOversubscriptionRule, contentionRule];

/** The first rule that settles the family; undefined when none does and the model must be asked. */
export function judge(family: FamilyDraft, host: HostContext): Judgement | undefined {
  for (const rule of RULES) {
    const judgement = rule(family, host);
    if (judgement !== undefined) return judgement;
  }
  return undefined;
}

/** What the rules need from the host as a whole. */
export function hostContext(snapshot: HostSnapshot, families: readonly FamilyDraft[]): HostContext {
  const loadRatio = snapshot.load.avg1 / snapshot.ncpu;
  const working = families.filter(isWork);
  const oversubscribed = loadRatio > CONTENTION_LOAD_RATIO && working.length >= MIN_CONTENDERS;
  return {
    loadRatio,
    ...(snapshot.uptime_s === undefined ? {} : { uptime_s: snapshot.uptime_s }),
    contenders: new Set(oversubscribed ? working.map((family) => family.root_pid) : []),
    busyModelServers:
      families.filter((family) => family.kind === "model_server" && family.cpu_pct >= MODEL_SERVER_IDLE_CPU_PCT).length,
    vms: new Map(snapshot.vms.map((vm) => [vm.pid, vm])),
  };
}
