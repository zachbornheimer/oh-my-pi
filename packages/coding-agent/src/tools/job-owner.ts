import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import type { BashResult } from "../exec/bash-executor";
import type { ParkedJobOutcome } from "../session/exit-diagnostics";

export const JOB_OWNER_ENV = "OMP_JOBOWNER";
export const JOB_OWNER_BROKER_SOCK_ENV = "OMP_BROKER_SOCK";
export const JOB_OWNER_JOBS_ROOT_ENV = "OMP_JOBS_ROOT";
export interface BrokerJobOwner { script: string; brokerSocket?: string; jobsRoot?: string; }
export interface BrokerJobSpawn {
 sessionId: string; toolCallId: string; command: string; cwd: string; env: Record<string, string>; signal?: AbortSignal;
}
export function brokerJobOwner(env: Record<string, string | undefined>): BrokerJobOwner | undefined {
 const script = env[JOB_OWNER_ENV];
 if (!script) return undefined;
 return { script, brokerSocket: env[JOB_OWNER_BROKER_SOCK_ENV], jobsRoot: env[JOB_OWNER_JOBS_ROOT_ENV] };
}
function ownerEnv(owner: BrokerJobOwner): Record<string, string | undefined> {
 return { ...Bun.env, ...(owner.brokerSocket ? { BROKER_SOCK: owner.brokerSocket } : {}), ...(owner.jobsRoot ? { JOBS_ROOT: owner.jobsRoot } : {}) };
}
/** The command is a single argv word, never interpreted by a shell in this process. */
export async function spawnBrokerJob(owner: BrokerJobOwner, job: BrokerJobSpawn): Promise<{ dir: string }> {
 const result = await ptree.exec([owner.script, "spawn", job.sessionId, job.toolCallId, job.command], {
  cwd: job.cwd, env: { ...ownerEnv(owner), ...job.env }, allowNonZero: true, signal: job.signal,
 });
 if (result.exitCode !== 0) throw new Error(`job owner refused the job: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
 const dir = result.stdout.trim().split("\n").at(-1) ?? "";
 if (!dir) throw new Error("job owner started the job but printed no job directory");
 return { dir };
}
interface ForegroundJob {
 sessionId: string; toolCallId: string; dir: string; parked: boolean; detach: () => void; release: () => void;
}
const foregroundJobs = new Set<ForegroundJob>();
export function parkableBrokerJob(sessionId: string): ForegroundJob | undefined {
 const jobs = [...foregroundJobs].filter(job => job.sessionId === sessionId);
 return jobs.length === 1 ? jobs[0] : undefined;
}
export function parkBrokerJob(sessionId: string, key: string): boolean {
 const job = parkableBrokerJob(sessionId);
 if (!job || job.toolCallId !== key || fs.existsSync(path.join(job.dir, "done.json"))) return false;
 job.parked = true;
 job.detach();
 return true;
}
export function brokerSessionParked(sessionId: string): boolean {
 return parkableBrokerJob(sessionId)?.parked === true;
}
export function releaseParkedBrokerWait(sessionId: string): void {
 for (const job of foregroundJobs) if (job.sessionId === sessionId && job.parked) job.release();
}
export function brokerJobDirectory(owner: BrokerJobOwner, sessionId: string, key: string): string {
 if (![sessionId, key].every(value => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value))) throw new Error("Invalid broker job identity");
 return path.join(owner.jobsRoot ?? path.join(os.homedir(), ".local/state/omp-broker/jobs"), sessionId, key);
}
async function outputTail(dir: string): Promise<{ output: string; bytes: number }> {
 const file = await fs.promises.open(path.join(dir, "output"), "r");
 try {
  const size = (await file.stat()).size;
  const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
  const read = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
  return { output: bytes.subarray(0, read.bytesRead).toString("utf8"), bytes: size };
 } finally { await file.close(); }
}
export async function claimBrokerOutcome(dir: string): Promise<(ParkedJobOutcome & { interrupted: boolean }) | undefined> {
 if (!fs.existsSync(path.join(dir, "done.json"))) return undefined;
 const { output } = await outputTail(dir);
 const raw = (await fs.promises.readFile(path.join(dir, "exit"), "utf8")).trim();
 const interrupted = raw === "130" || raw === "143" || raw === "killed";
 try { await (await fs.promises.open(path.join(dir, "claimed"), "wx")).close(); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
 return { text: `${output}\n[${interrupted ? "interrupted" : `exit code ${raw}`}]`, isError: raw !== "0", interrupted };
}
/** Directory events cover atomic done.json renames; no polling interval runs while waiting. */
export function waitBrokerJob(owner: BrokerJobOwner, sessionId: string, key: string, dir: string,
 options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string) => void } = {}): Promise<BashResult> {
 const { promise, resolve, reject } = Promise.withResolvers<BashResult>();
  let checking = false, dirty = false, finished = false, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kill: Promise<void> | undefined;
  const cleanup = () => { watcher.close(); clearTimeout(timer); options.signal?.removeEventListener("abort", abort); foregroundJobs.delete(job); };
  const job: ForegroundJob = { sessionId, toolCallId: key, dir, parked: false, detach: () => { watcher.close(); clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }, release: () => reject(new Error("Foreground call parked")) };
  const stop = () => {
   if (job.parked || finished || kill) return;
   kill = ptree.exec([owner.script, "kill", sessionId, key], { env: ownerEnv(owner), allowNonZero: true }).then(result => {
    if (result.exitCode !== 0) throw new Error(result.stderr || "job owner kill failed");
   });
   void kill.then(check, error => { cleanup(); reject(error); });
  };
  const abort = () => stop();
  const check = async () => {
   if (finished || job.parked) return;
   if (checking) { dirty = true; return; }
   checking = true;
   try {
    do {
     dirty = false;
     const tail = await outputTail(dir);
     options.onOutput?.(tail.output);
     if (!fs.existsSync(path.join(dir, "done.json"))) continue;
     const raw = (await fs.promises.readFile(path.join(dir, "exit"), "utf8")).trim();
     if (kill) await kill;
     if (job.parked) return;
     finished = true;
     cleanup();
     const lines = tail.output.length ? tail.output.split("\n").length : 0;
     resolve({ output: tail.output, exitCode: raw === "killed" ? 143 : Number(raw), cancelled: options.signal?.aborted === true && !timedOut, timedOut,
      truncated: tail.bytes > 64 * 1024, totalBytes: tail.bytes, totalLines: lines, outputLines: lines, outputBytes: Buffer.byteLength(tail.output) });
    } while (dirty && !finished);
   } catch (error) { cleanup(); reject(error); } finally { checking = false; }
  };
  const watcher = fs.watch(dir, (_event, filename) => { if (filename === "done.json" || filename === "output") void check(); });
  watcher.on("error", error => { cleanup(); reject(error); });
  for (const previous of foregroundJobs) if (previous.dir === dir && previous.parked) foregroundJobs.delete(previous);
  foregroundJobs.add(job);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.timeoutMs !== undefined) timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  if (options.signal?.aborted) abort();
  void check();
 return promise;
}
