import { hookPhaseInChain, scopeOf, triggerOf } from "./family_context.ts";
import { ProcessTree } from "./process_tree.ts";
import type { Family, HostSnapshot, ProcessKind, ProcessSample } from "./types.ts";

/** A family before any verdict: everything the rules read, and nothing they decide. */
export interface FamilyDraft extends Omit<Family, "verdict" | "confidence" | "evidence" | "remedy" | "advice"> {
  /** The member that does the work: the heaviest gate, test or build, else the root. */
  readonly worker: ProcessSample;
  /** The most members that share one command base name. */
  readonly sameBaseMax: number;
  /** The kinds of the root's ancestors, nearest first. */
  readonly ancestryKinds: readonly ProcessKind[];
  /** The hook configuration file of `repo`, when it has one. */
  readonly hook_config?: string;
}

const WORK_KINDS: readonly ProcessKind[] = ["gate", "test", "build"];
const ORCHESTRATOR_BASE = "hk";
const SCOPED_KINDS: readonly ProcessKind[] = ["gate", "test"];
const ONE_DECIMAL = 10;

const round = (value: number): number => Math.round(value * ONE_DECIMAL) / ONE_DECIMAL;
const sum = (members: readonly ProcessSample[], field: "cpu_pct" | "rss_mb"): number =>
  round(members.reduce((total, member) => total + member[field], 0));

/** The heaviest process that runs a gate, test or build; the hook runner `hk` only when nothing else does. */
function workerOf(members: readonly ProcessSample[], tree: ProcessTree): ProcessSample | undefined {
  const working = members.filter((member) => WORK_KINDS.includes(tree.kind(member.pid)));
  const doing = working.filter((member) => tree.baseName(member) !== ORCHESTRATOR_BASE);
  const pool = doing.length > 0 ? doing : working;
  return [...pool].sort((a, b) => b.cpu_pct - a.cpu_pct || b.rss_mb - a.rss_mb)[0];
}

/** The command base shared by the most CPU among the root's descendants, or the root's own when it has none. */
function dominantChildName(root: ProcessSample, members: readonly ProcessSample[], tree: ProcessTree): string {
  const cpuByBase = new Map<string, number>();
  for (const member of members) {
    if (member.pid === root.pid) continue;
    const base = tree.baseName(member);
    cpuByBase.set(base, (cpuByBase.get(base) ?? 0) + member.cpu_pct + member.rss_mb / 1024);
  }
  const heaviest = [...cpuByBase.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rootName = tree.baseName(root);
  return heaviest === undefined || heaviest === rootName ? rootName : `${rootName} (${heaviest})`;
}

function largestSameBase(members: readonly ProcessSample[], tree: ProcessTree): number {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(tree.baseName(member), (counts.get(tree.baseName(member)) ?? 0) + 1);
  return Math.max(...counts.values());
}

function repoOf(root: ProcessSample, members: readonly ProcessSample[], snapshot: HostSnapshot): string | undefined {
  for (const member of [root, ...members]) {
    const cwd = snapshot.cwd[String(member.pid)];
    const repo = cwd === undefined ? undefined : snapshot.repo[cwd];
    if (repo !== undefined) return repo;
  }
  return undefined;
}

function draftOf(
  root: ProcessSample,
  members: readonly ProcessSample[],
  snapshot: HostSnapshot,
  tree: ProcessTree,
): FamilyDraft {
  const worker = workerOf(members, tree) ?? root;
  const chain = [worker, ...tree.ancestors(worker)];
  const above = tree.ancestors(root);
  const rootKind = tree.kind(root.pid);
  const workerKind = tree.kind(worker.pid);
  const kind = rootKind === "git" && WORK_KINDS.includes(workerKind) ? workerKind : rootKind;
  const repo = repoOf(root, members, snapshot);
  const trigger = triggerOf(chain, tree);
  const hook_phase = hookPhaseInChain(chain);
  const hook_config = repo === undefined ? undefined : snapshot.hook_config[repo];
  return {
    name: dominantChildName(root, members, tree),
    root_pid: root.pid,
    pids: members.map((member) => member.pid),
    count: members.length,
    cpu_pct: sum(members, "cpu_pct"),
    rss_mb: sum(members, "rss_mb"),
    age_s: root.age_s,
    kind,
    ancestry: above.map((process) => tree.baseName(process)),
    ancestryKinds: above.map((process) => tree.kind(process.pid)),
    ...(trigger === undefined ? {} : { trigger }),
    ...(repo === undefined ? {} : { repo }),
    ...(hook_phase === undefined ? {} : { hook_phase }),
    ...(hook_config === undefined ? {} : { hook_config }),
    ...(SCOPED_KINDS.includes(kind) ? { scope: scopeOf(worker.command) } : {}),
    worker,
    sameBaseMax: largestSameBase(members, tree),
  };
}

/** Every process grouped under the process that roots it: one draft per family, unranked. */
export function familyDrafts(snapshot: HostSnapshot): FamilyDraft[] {
  const tree = new ProcessTree(snapshot.processes);
  const rootOf = new Map<number, ProcessSample>();
  const membersOf = new Map<number, ProcessSample[]>();
  for (const process of snapshot.processes) {
    const root = tree.root(process);
    rootOf.set(root.pid, root);
    const members = membersOf.get(root.pid) ?? [];
    members.push(process);
    membersOf.set(root.pid, members);
  }
  return [...membersOf.entries()].map(([rootPid, members]) => draftOf(rootOf.get(rootPid)!, members, snapshot, tree));
}
